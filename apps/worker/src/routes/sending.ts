import { Hono } from "hono";
import { z } from "zod";
import { SendingStatus, SetSendingViaInputSchema, type SendingPreview } from "@mailvault/shared";
import type { AppEnv } from "../app-env";
import { domainDenylist } from "../env";
import { getDomainByZoneId, listDomains, setDomainSending, setDomainSendingVia } from "../db/domains";
import { log } from "../lib/logging";
import { nowIso } from "../lib/util";
import { AppError, badRequest } from "../lib/errors";
import { CloudflareApiError } from "../cf/api-client";
import type { CloudflareClient } from "../cf/api-client";
import { actorOf, asApiError, cfClient, readJson } from "./_helpers";
import { requireStepUp } from "./security";

const ZoneIdParam = z.object({ id: z.string().min(1) });
const EnableBody = z.object({ allowDmarcTakeover: z.boolean().default(false) });

/** Codes that mean "a DMARC record already exists here", from Cloudflare's own preview. */
const DMARC_CODES = new Set(["dmarc.multiple", "dmarc.incompatible"]);

/**
 * The Email Sending name this domain's mail goes out under — a chosen subdomain when the owner
 * picked one, the domain itself otherwise. Cloudflare onboards sending per name inside a zone,
 * so this is the name every sending question has to be asked about.
 */
function sendingName(domain: { name: string; sendingVia: string | null }): string {
  return domain.sendingVia ?? domain.name;
}

async function stateOf(client: CloudflareClient, zoneId: string, name: string) {
  const rows = await client.listSendingDomains(zoneId);
  const row = rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
  return row?.enabled
    ? { status: SendingStatus.Enabled as SendingStatus, tag: row.tag }
    : { status: SendingStatus.Disabled as SendingStatus, tag: null };
}

/**
 * What enabling sending would write, computed before anybody is asked to confirm it.
 *
 * The preview endpoint is a documented read-only dry run, so this is the honest moment to
 * show the owner the exact records — including the `_dmarc` row, whose policy applies to the
 * whole domain and can therefore disturb senders MailVault knows nothing about.
 */
async function previewDomainSending(
  client: CloudflareClient,
  db: D1Database,
  domain: { id: string; cloudflareZoneId: string; name: string; sendingVia: string | null },
): Promise<SendingPreview> {
  const target = sendingName(domain);
  const preview = await client.previewSending(domain.cloudflareZoneId, target);
  const conflicts = preview.errors.filter((e) => !!e.existing || (e.multiple?.length ?? 0) > 0 || DMARC_CODES.has(e.code));
  const dmarcConflict = preview.errors.some(
    (e) => DMARC_CODES.has(e.code) || (e.code.startsWith("dmarc.") && (!!e.existing || (e.multiple?.length ?? 0) > 0)),
  );
  const alreadyEnabled = (await stateOf(client, domain.cloudflareZoneId, target)).status === SendingStatus.Enabled;
  const result: SendingPreview = {
    domainId: domain.id,
    domainName: target,
    alreadyEnabled,
    records: preview.records.map((r) => ({
      name: r.name,
      type: r.type,
      content: r.content,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
    })),
    issues: conflicts.map((e) => ({
      code: e.code,
      existing: e.existing?.content ?? e.multiple?.map((m) => m.content).join(" | ") ?? null,
    })),
    dmarcConflict,
    checkedAt: nowIso(),
  };
  await setDomainSending(db, domain.id, {
    sendingStatus: result.alreadyEnabled ? SendingStatus.Enabled : SendingStatus.Disabled,
    ...(result.alreadyEnabled ? {} : { sendingTag: null }),
  });
  return result;
}

/**
 * Sending, kept apart from the receiving state machine in `domains`.
 *
 * Enabling it writes only `cf-bounce.*` and `_dmarc.*` records for that name, never the
 * domain's MX, so it cannot take mail away from another provider — the guardrail that
 * governs receiving does not apply here, and the one that does is DMARC: a domain-wide
 * policy that affects senders beyond this app. That is why a conflicting `_dmarc` needs both
 * a checkbox and a passkey, and why nothing here runs on load or on a schedule.
 */
export const sendingRoute = new Hono<AppEnv>()
  /** Read-only refresh of what Cloudflare says about every managed domain. */
  .post("/api/sending/refresh", async (c) => {
    const client = cfClient(c.env);
    const domains = await listDomains(c.env.DB);
    const out: { domain: string; via: string; status: string; error?: string }[] = [];
    for (const d of domains) {
      const via = sendingName(d);
      try {
        const state = await stateOf(client, d.cloudflareZoneId, via);
        await setDomainSending(c.env.DB, d.id, { sendingStatus: state.status, sendingTag: state.tag });
        out.push({ domain: d.name, via, status: state.status });
      } catch (err) {
        const message = err instanceof CloudflareApiError ? err.message : "check failed";
        out.push({ domain: d.name, via, status: SendingStatus.Unknown, error: message });
      }
    }
    log.info("sending_refreshed", { actor: actorOf(c).email, domains: out.length });
    return c.json({ items: out });
  })

  /**
   * Every Email Sending name this zone has, enabled or not.
   *
   * Read live rather than stored: the list is Cloudflare's, it is small, and a cached copy would
   * be exactly the kind of stale fact that makes an owner enable a name twice.
   */
  .get("/api/domains/:id/sending/names", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw badRequest("Unknown domain");
    try {
      const rows = await cfClient(c.env).listSendingDomains(domain.cloudflareZoneId);
      return c.json({
        items: rows
          .map((r) => ({ name: r.name, enabled: !!r.enabled, tag: r.tag ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    } catch (err) {
      throw asApiError(err);
    }
  })

  /**
   * Point a domain's mail at one of its zone's sending names.
   *
   * This writes nothing at Cloudflare — it only decides which name the other routes in this file
   * ask about, and which address a compose leaves from. The chosen name has to live inside this
   * zone, because a sending identity belongs to the zone whose DNS signs for it.
   */
  .put("/api/domains/:id/sending-via", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const { name } = await readJson(c, SetSendingViaInputSchema);
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw badRequest("Unknown domain");

    const apex = domain.name.toLowerCase();
    const target = name?.trim().toLowerCase() ?? null;
    if (target && target !== apex && !target.endsWith(`.${apex}`)) {
      throw badRequest(`${target} is not a name inside ${domain.name}.`);
    }
    // Choosing the apex by its own name is the same decision as choosing nothing.
    const via = target && target !== apex ? target : null;

    await setDomainSendingVia(c.env.DB, domain.id, via);
    let status: SendingStatus = SendingStatus.Unknown;
    try {
      status = (await stateOf(cfClient(c.env), domain.cloudflareZoneId, via ?? domain.name)).status;
      await setDomainSending(c.env.DB, domain.id, { sendingStatus: status, sendingTag: null });
    } catch (err) {
      // The choice stands even when Cloudflare cannot be reached right now; the next refresh
      // fills the state in. Refusing here would leave the owner with a half-made decision.
      log.warn("sending_via_state_unread", { zoneId, error: err instanceof Error ? err.message : "check failed" });
    }
    log.info("domain_sending_via_set", { actor: actorOf(c).email, domain: domain.name, via: via ?? domain.name, status });
    return c.json({ domainId: domain.id, sendingVia: via, sendingStatus: status });
  })

  .get("/api/domains/:id/sending", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw badRequest("Unknown domain");
    const preview = await previewDomainSending(cfClient(c.env), c.env.DB, domain).catch((err) => {
      throw asApiError(err);
    });
    return c.json(preview);
  })

  .post("/api/domains/:id/sending/preview", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw badRequest("Unknown domain");
    try {
      return c.json(await previewDomainSending(cfClient(c.env), c.env.DB, domain));
    } catch (err) {
      throw asApiError(err);
    }
  })

  /** The only mutation here, and only on an explicit owner request. */
  .post("/api/domains/:id/sending", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const body = await readJson(c, EnableBody);
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw badRequest("Unknown domain");

    if (domainDenylist(c.env).includes(domain.name.toLowerCase())) {
      throw new AppError(
        409,
        "DOMAIN_DENYLISTED",
        `${domain.name} is excluded from MailVault management by DOMAIN_DENYLIST.`,
      );
    }

    const client = cfClient(c.env);
    const target = sendingName(domain);
    // Read the ground truth first and act on it, not on what the last request said: the
    // checkbox only means anything if the conflict it refers to is still there.
    const preview = await previewDomainSending(client, c.env.DB, domain);
    if (preview.dmarcConflict && !body.allowDmarcTakeover) {
      throw new AppError(
        409,
        "DMARC_CONFLICT",
        `${target} already has a DMARC record. Enabling sending would change it, and that policy covers every sender using this domain.`,
        { records: preview.records, issues: preview.issues },
      );
    }
    if (preview.dmarcConflict) await requireStepUp(c, "dmarc.takeover");
    if (preview.alreadyEnabled) {
      return c.json({ domainId: domain.id, sendingStatus: SendingStatus.Enabled, alreadyEnabled: true });
    }

    try {
      const row = await client.enableSending(domain.cloudflareZoneId, target);
      await setDomainSending(c.env.DB, domain.id, { sendingStatus: SendingStatus.Enabled, sendingTag: row.tag });
      log.info("domain_sending_enabled", { actor: actorOf(c).email, zoneId, domain: target, tookOverDmarc: preview.dmarcConflict });
      return c.json({ domainId: domain.id, sendingStatus: SendingStatus.Enabled, alreadyEnabled: false, records: preview.records }, 201);
    } catch (err) {
      const mapped = asApiError(err);
      if (mapped instanceof AppError) throw mapped;
      throw new AppError(502, "SENDING_ENABLE_FAILED", "Cloudflare refused to enable sending for this domain.");
    }
  });
