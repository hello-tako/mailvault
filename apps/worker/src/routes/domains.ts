import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  AuthPolicy,
  DomainIdsBodySchema,
  PreflightClassification,
  type DiscoveredZone, ConfirmationTokenSchema } from "@mailvault/shared";
import type { AppEnv } from "../app-env";
import { domainDenylist } from "../env";
import {
  getDomainByZoneId,
  listDomains,
  recordProvisioningEvent,
  setDomainAuthPolicy,
  upsertDiscoveredZones,
} from "../db/domains";
import { preflightMany, provisionMany, provisionDomain } from "../provisioning/provisioner";
import { buildSetupNext, mergeSpfRecords, type SetupSnapshot } from "../provisioning/setup";
import { publicMxResolvable, runWatchdog } from "../provisioning/watchdog";
import { log } from "../lib/logging";
import { badRequest, notFound, AppError } from "../lib/errors";
import { actorOf, asApiError, cfClient, readJson } from "./_helpers";
import { requireStepUp } from "./security";
import { preflightZone, verifyDeliveryPath } from "../provisioning/preflight";
import { getSetting, setSetting } from "../db/settings";
import { newId } from "../lib/util";
import { sendOutbound } from "../mail/send";
import { createAlias, deleteAlias } from "../db/aliases";
import type { CfDnsRecord } from "../cf/types";

const ZoneIdParam = z.object({ id: z.string().min(1) });

/** The auto-provision switch: "1" means a Sync may itself provision newly discovered zones
 * that preflight clears as READY_TO_PROVISION — never anything with a conflict, because
 * provisionDomain refuses those without the owner's explicit takeover confirmations. */
const AUTO_PROVISION_KEY = "autoProvisionCleanZones";
const AutoProvisionBody = z.object({ enabled: z.boolean() });

/** Provision/preflight bodies accept explicit, dangerous-action takeover confirmations. */
const ProvisionBodySchema = DomainIdsBodySchema.extend({
  allowCatchAllTakeover: z.boolean().default(false),
  allowMxTakeover: z.boolean().default(false),
});

function requireWorkerName(env: AppEnv["Bindings"]): string {
  const name = env.MAIL_WORKER_NAME;
  if (!name) {
    throw new AppError(
      503,
      "WORKER_NAME_UNSET",
      "MAIL_WORKER_NAME must be configured so catch-all rules can target this Worker.",
    );
  }
  return name;
}

async function authorizeTakeovers(
  c: Context<AppEnv>,
  zoneIds: string[],
  workerName: string,
  flags: { allowMxTakeover: boolean; allowCatchAllTakeover: boolean },
): Promise<void> {
  const client = cfClient(c.env);
  const results = await preflightMany(c.env.DB, client, zoneIds, workerName);
  const eligible = new Set<PreflightClassification>([
    PreflightClassification.MxConflict,
    PreflightClassification.CatchAllConflict,
    PreflightClassification.ReadyToProvision,
    PreflightClassification.AlreadyConfigured,
  ]);

  // Resolve authorization for the entire batch before any domain can be mutated.
  for (const result of results) {
    if (!eligible.has(result.classification)) continue;
    const path = await verifyDeliveryPath(client, result.zoneId, workerName);
    if (flags.allowMxTakeover && path.mx.foreign.length > 0)
      await requireStepUp(c, "provision.mx-takeover");
    if (flags.allowCatchAllTakeover && path.foreignCatchAll)
      await requireStepUp(c, "provision.catch-all-takeover");
  }
}


/** The probe's sender: the first alias on a sending-enabled domain. */
async function listSendingEnabledDomains(db: D1Database): Promise<Array<{ aliasAddress: string }>> {
  const { results } = await db
    .prepare(
      `SELECT a.address AS aliasAddress FROM aliases a JOIN domains d ON d.id = a.domain_id
       WHERE d.sending_status = 'ENABLED' AND a.status = 'ACTIVE' ORDER BY a.created_at ASC LIMIT 1`,
    )
    .all<{ aliasAddress: string }>();
  return (results ?? []).map((r) => ({ aliasAddress: r.aliasAddress }));
}

export const domainsRoute = new Hono<AppEnv>()
  .get("/api/domains", async (c) => c.json({ items: await listDomains(c.env.DB) }))

  /** Opt-in: Sync may itself enable mail on newly discovered zones that preflight clears. */
  .get("/api/domains/auto-provision", async (c) => {
    try {
      return c.json({ enabled: (await getSetting(c.env.DB, AUTO_PROVISION_KEY)) === "1" });
    } catch (err) {
      throw asApiError(err);
    }
  })
  .put("/api/domains/auto-provision", async (c) => {
    try {
      const body = await readJson(c, AutoProvisionBody);
      await setSetting(c.env.DB, AUTO_PROVISION_KEY, body.enabled ? "1" : "0");
      log.info("auto_provision_setting", { actor: actorOf(c).email, enabled: body.enabled });
      return c.json({ enabled: body.enabled });
    } catch (err) {
      throw asApiError(err);
    }
  })

  /** Discovery is read-only against Cloudflare — it never mutates a zone (section 9). */
  .post("/api/domains/sync", async (c) => {
    try {
      const client = cfClient(c.env);
      const zones = await client.listAllZones();
      const discovered: DiscoveredZone[] = zones.map((z) => ({
        cloudflareZoneId: z.id,
        cloudflareAccountId: z.account?.id ?? c.env.CF_ACCOUNT_ID ?? null,
        name: z.name,
        status: z.status,
        type: z.type,
        account: z.account ? { id: z.account.id ?? null, name: z.account.name ?? null } : null,
      }));
      await upsertDiscoveredZones(c.env.DB, discovered);
      log.info("domains_synced", { actor: actorOf(c).email, discovered: discovered.length });
      let autoProvisioned: string[] = [];
      if ((await getSetting(c.env.DB, AUTO_PROVISION_KEY)) === "1") {
        // Only zones this sync brought in as DISCOVERED are candidates — a row in any other
        // state is history the owner already shaped. provisionDomain re-runs its own
        // preflight and refuses anything short of clean, so this can never take over an MX
        // or a catch-all; those still wait for the explicit button with its confirmations.
        const fresh = await c.env.DB
          .prepare(`SELECT cloudflare_zone_id AS id FROM domains WHERE mail_status = 'DISCOVERED'`)
          .all<{ id: string }>();
        const zoneIds = (fresh.results ?? []).map((r) => r.id);
        if (zoneIds.length) {
          const workerName = requireWorkerName(c.env);
          const outcomes = await provisionMany(c.env.DB, client, zoneIds, workerName, {
            denyDomains: domainDenylist(c.env),
          });
          autoProvisioned = outcomes.filter((o) => o.ok).map((o) => o.name);
          log.info("domains_auto_provisioned", {
            attempted: zoneIds.length,
            ok: autoProvisioned.length,
          });
        }
      }
      return c.json({
        discovered: discovered.length,
        autoProvisioned,
        items: await listDomains(c.env.DB),
      });
    } catch (err) {
      throw asApiError(err);
    }
  })

  /** Preflight classifies safety for each selected zone. Performs no mutation. */
  .post("/api/domains/preflight", async (c) => {
    try {
      const body = await readJson(c, DomainIdsBodySchema);
      const client = cfClient(c.env);
      const workerName = requireWorkerName(c.env);
      const results = await preflightMany(c.env.DB, client, body.zoneIds, workerName);
      return c.json({ results });
    } catch (err) {
      throw asApiError(err);
    }
  })

  /** Provision mutates Cloudflare — only ever after this explicit, authenticated action. */
  .post("/api/domains/provision", async (c) => {
    try {
      const body = await readJson(c, ProvisionBodySchema);
      const client = cfClient(c.env);
      const workerName = requireWorkerName(c.env);
      await authorizeTakeovers(c, body.zoneIds, workerName, {
        allowMxTakeover: body.allowMxTakeover,
        allowCatchAllTakeover: body.allowCatchAllTakeover,
      });
      const results = await provisionMany(c.env.DB, client, body.zoneIds, workerName, {
        allowCatchAllTakeover: body.allowCatchAllTakeover,
        allowMxTakeover: body.allowMxTakeover,
        denyDomains: domainDenylist(c.env),
        authorizeTakeover: (operation) => requireStepUp(c, operation),
      });
      log.info("domains_provisioned", {
        actor: actorOf(c).email,
        count: results.length,
        ok: results.filter((r) => r.ok).length,
        takeover: body.allowCatchAllTakeover,
        mxTakeover: body.allowMxTakeover,
      });
      return c.json({ results });
    } catch (err) {
      throw asApiError(err);
    }
  })

  /**
   * Merge a zone's duplicate SPF records into one (plan W3). Destructive — old records are
   * deleted, each one logged to the event stream first, exactly like the MX take-over — so
   * it needs the owner's explicit tick and the passkey.
   */
  .post("/api/domains/:id/spf-merge", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw notFound("Domain not found");
    await readJson(c, ConfirmationTokenSchema);
    await requireStepUp(c, "provision.spf-merge");
    const client = cfClient(c.env);

    const records = await client.listDnsRecords(zoneId, "TXT");
    const spf = records.filter((r) => /^v=spf1/i.test((r.content ?? "").trim()));
    if (spf.length < 2) return c.json({ merged: false, reason: "fewer than two SPF records" });

    const merged = mergeSpfRecords(spf.map((r) => r.content ?? ""));
    if (!merged) return c.json({ merged: false, reason: "merge produced nothing" });

    // Say what is about to be replaced, then do it: create, verify, delete — the same
    // order that keeps a domain never without its records.
    await recordProvisioningEvent(c.env.DB, domain.id, "provision:spf_merge", "RUNNING", {
      removing: spf.map((r) => ({ id: r.id, name: r.name, content: r.content })),
      creating: merged,
    });
    const created = await client.createDnsRecord(zoneId, { type: "TXT", name: spf[0]!.name, content: merged });
    const after = await client.listDnsRecords(zoneId, "TXT");
    if (!after.some((r) => r.id === created.id)) {
      await recordProvisioningEvent(c.env.DB, domain.id, "provision:spf_merge", "FAILED", {
        reason: "created record did not appear",
      });
      return c.json({ merged: false, reason: "created record did not appear" });
    }
    for (const r of spf) {
      await client.deleteDnsRecord(zoneId, r.id);
    }
    await recordProvisioningEvent(c.env.DB, domain.id, "provision:spf_merge", "DONE", { content: merged });
    log.info("spf_merged", { zoneId, removed: spf.length, actor: actorOf(c).email });
    return c.json({ merged: true, content: merged, removed: spf.length });
  })

  /**
   * Send a probe — a real letter from a sending-enabled domain to a fresh alias on this
   * one (plan W4/A8) — then let the wizard poll for its arrival.
   */
  .post("/api/domains/:id/probe", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw notFound("Domain not found");
    if (domain.mailStatus !== "READY") {
      throw new AppError(409, "NOT_READY", "Enable receiving on this domain first — the probe has nowhere to land.");
    }
    const senders = await listSendingEnabledDomains(c.env.DB);
    if (senders.length === 0) {
      throw new AppError(
        409,
        "NO_SENDER",
        "No domain is enabled for sending yet. Enable Email Sending on one domain first, then the probe can travel.",
      );
    }
    const sender = senders[0]!;
    const local = `setup-probe-${newId().slice(0, 8)}`;
    const alias = await createAlias(c.env.DB, {
      domainId: domain.id,
      domainName: domain.name,
      localPart: local,
      label: "Setup probe",
    });
    const result = await sendOutbound(
      {
        idempotencyKey: `probe-${alias.id}`,
        fromAddress: sender.aliasAddress,
        to: [alias.address],
        subject: `MailVault setup probe — ${domain.name}`,
        text:
          "This is an automated probe sent by Mail Setup to prove the whole road works: " +
          "out through Email Sending, back in through Email Routing. It may be deleted.",
      },
      c.env,
      c.env.DB,
      c.env.MAIL_BUCKET,
    );
    if (!result.ok) {
      await deleteAlias(c.env.DB, alias.id, false);
      throw new AppError(502, result.code, result.message);
    }
    log.info("setup_probe_sent", { zoneId, aliasId: alias.id, from: sender.aliasAddress });
    return c.json({ probeAddress: alias.address, aliasId: alias.id, sentAt: new Date().toISOString() }, 201);
  })

  /** Did the probe arrive? When it does, the probe alias cleans itself up with it. */
  .get("/api/domains/:id/probe", async (c) => {
    const aliasId = c.req.query("aliasId") ?? "";
    const arrived = await c.env.DB
      .prepare(
        `SELECT m.id AS mid FROM messages m JOIN aliases a ON a.id = m.alias_id
         WHERE a.id = ?1 AND m.direction = 'IN' AND m.received_at >= datetime('now', '-15 minutes') LIMIT 1`,
      )
      .bind(aliasId)
      .first<{ mid: string }>();
    if (arrived) {
      // The probe proved the road; its alias and its letter were system artifacts.
      await deleteAlias(c.env.DB, aliasId, true);
      return c.json({ arrived: true, messageId: arrived.mid });
    }
    return c.json({ arrived: false });
  })

  /**
   * The Mail Setup wizard's one-read diagnosis (plan W1): receiving, sending, public DNS
   * and the token's reach for one zone, plus the ordered next actions. Read-only.
   */
  .get("/api/domains/:id/setup", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw notFound("Domain not found");
    const workerName = requireWorkerName(c.env);
    const client = cfClient(c.env);

    // Parallel, best-effort: one read failing says something about the token, not the zone.
    const [pf, path, txt, sendingPreview, sendingNames, dnsPublic] = await Promise.all([
      preflightZone(client, { zoneId, name: domain.name, status: domain.zoneStatus, type: domain.zoneType }, workerName)
        .catch(() => null),
      verifyDeliveryPath(client, zoneId, workerName).catch(() => null),
      client.listDnsRecords(zoneId, "TXT").catch(() => null) as Promise<CfDnsRecord[] | null>,
      client.previewSending(zoneId, domain.name).catch(() => null),
      client.listSendingDomains(zoneId).catch(() => null),
      publicMxResolvable(domain.name),
    ]);

    const readsZone = !!pf && pf.classification !== PreflightClassification.ApiPermissionError;
    const tokenHint = readsZone
      ? null
      : "MailVault's API token cannot read this zone. Add the zone (or 'All zones from an " +
        "account') to the token's Zone Resources, and give it Zone → Email Routing Rules → Edit " +
        "and Email Sending → Edit — then reopen this screen.";

    const spfRecords = (txt ?? []).map((r: CfDnsRecord) => r.content ?? "").filter((v: string) => /^v=spf1/i.test(v.trim()));
    const sendingEnabled =
      domain.sendingStatus === "ENABLED" ||
      (sendingNames ?? []).some((n: { name?: string; enabled?: boolean }) => n.enabled);
    const dmarcConflict =
      sendingPreview?.errors?.some((e: { code?: string }) => ["dmarc.multiple", "dmarc.incompatible"].includes(e.code ?? "")) ?? false;

    const snapshot: SetupSnapshot = {
      domain: {
        id: domain.id,
        zoneId,
        name: domain.name,
        mailStatus: domain.mailStatus,
        sendingStatus: domain.sendingStatus,
        sendingVia: domain.sendingVia,
      },
      token: { readsZone, hint: tokenHint },
      receiving: {
        classification: pf?.classification ?? PreflightClassification.ProvisioningError,
        conflict: pf?.conflict ?? null,
        routing: path?.routing ?? false,
        catchAllOurs: path?.catchAllOurs ?? false,
        mxCloudflare: path?.mx.cloudflareRouting ?? 0,
        mxForeign: path?.mx.foreign.length ?? 0,
        mxProviders: path?.mx.providers ?? [],
      },
      dnsPublic: { resolvable: dnsPublic },
      sending: {
        enabled: !!sendingEnabled,
        records: (sendingPreview?.records ?? []) as unknown as Array<Record<string, unknown>>,
        dmarcConflict,
        unavailableReason: sendingPreview ? null : "sending-preview-unavailable",
      },
      spf: { count: spfRecords.length, records: spfRecords },
    };

    return c.json({ ...snapshot, next: buildSetupNext(snapshot) });
  })

  /** Retry = provision one domain; :id is the Cloudflare zone id. */
  .post("/api/domains/:id/retry", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    try {
      // Retry may be sent with no body; absence means "no takeover confirmation".
      let allowCatchAllTakeover = false;
      let allowMxTakeover = false;
      try {
        const body = await readJson(
          c,
          z.object({
            allowCatchAllTakeover: z.boolean().optional(),
            allowMxTakeover: z.boolean().optional(),
          }),
        );
        allowCatchAllTakeover = body.allowCatchAllTakeover ?? false;
        allowMxTakeover = body.allowMxTakeover ?? false;
      } catch {
        /* empty/absent body is fine for a retry */
      }
      const client = cfClient(c.env);
      const workerName = requireWorkerName(c.env);
      await authorizeTakeovers(c, [zoneId], workerName, { allowCatchAllTakeover, allowMxTakeover });
      const result = await provisionDomain(c.env.DB, client, zoneId, workerName, {
        allowCatchAllTakeover,
        allowMxTakeover,
        denyDomains: domainDenylist(c.env),
        authorizeTakeover: (operation) => requireStepUp(c, operation),
      });
      return c.json(result);
    } catch (err) {
      throw asApiError(err);
    }
  })

  /**
   * Re-verify the delivery path of every domain MailVault believes works (or flagged as
   * drifted). Read-only against Cloudflare; updates MailVault's own rows only.
   */
  .post("/api/domains/verify", async (c) => {
    try {
      const client = cfClient(c.env);
      const report = await runWatchdog(c.env.DB, client, requireWorkerName(c.env));
      log.info("domains_verified", {
        actor: actorOf(c).email,
        checked: report.checked,
        drifted: report.drifted.length,
        failed: report.failed.length,
      });
      return c.json({ report, items: await listDomains(c.env.DB) });
    } catch (err) {
      throw asApiError(err);
    }
  })

  /**
   * Owner sets how this domain treats mail whose sender failed authentication.
   * Local setting only — it never touches Cloudflare.
   */
  .patch("/api/domains/:id/auth-policy", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const body = await readJson(c, z.object({ policy: z.nativeEnum(AuthPolicy) }));
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw notFound("Domain not found");
    // Weakening this is exactly what an attacker with a stolen session would want, and it
    // is invisible in the mail that then arrives.
    if (body.policy === AuthPolicy.Off) await requireStepUp(c, "auth-policy.weaken");
    await setDomainAuthPolicy(c.env.DB, domain.id, body.policy);
    log.info("domain_auth_policy_set", { actor: actorOf(c).email, zoneId, policy: body.policy });
    return c.json({ zoneId, authPolicy: body.policy });
  })

  /**
   * Forget a domain from MailVault. This ONLY removes local tracking rows —
   * it never deletes or mutates the Cloudflare zone (section: removing must not
   * delete the zone). Refuses while aliases still depend on it to avoid a
   * surprising cascade.
   */
  .delete("/api/domains/:id", async (c) => {
    const { id: zoneId } = ZoneIdParam.parse({ id: c.req.param("id") });
    const domain = await getDomainByZoneId(c.env.DB, zoneId);
    if (!domain) throw notFound("Domain not found");
    await requireStepUp(c, "domain.forget");
    const deleted = await c.env.DB.prepare(
      `DELETE FROM domains
         WHERE id = ?1
           AND NOT EXISTS (SELECT 1 FROM aliases WHERE domain_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM messages WHERE domain_id = ?1)`,
    )
      .bind(domain.id)
      .run();
    if (!deleted.meta.changes) {
      const [aliasCount, messageCount] = await Promise.all([
        c.env.DB.prepare(`SELECT COUNT(*) AS c FROM aliases WHERE domain_id = ?1`)
          .bind(domain.id)
          .first<{ c: number }>(),
        c.env.DB.prepare(`SELECT COUNT(*) AS c FROM messages WHERE domain_id = ?1`)
          .bind(domain.id)
          .first<{ c: number }>(),
      ]);
      if (Number(messageCount?.c ?? 0) > 0) {
        throw badRequest(
          "This domain still has historical mail. Purge or otherwise resolve those messages before forgetting the domain.",
          {
            messageCount: Number(messageCount?.c ?? 0),
          },
        );
      }
      if (Number(aliasCount?.c ?? 0) > 0) {
        throw badRequest("Remove or reassign this domain's aliases before removing it.", {
          aliasCount: Number(aliasCount?.c ?? 0),
        });
      }
      throw notFound("Domain not found");
    }
    log.info("domain_forgotten", { actor: actorOf(c).email, zoneId });
    return c.json({ removed: true, zoneId });
  });
