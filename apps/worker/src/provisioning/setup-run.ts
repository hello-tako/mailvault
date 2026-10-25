import type { Env } from "../env";
import { PreflightClassification } from "@mailvault/shared";
import { createCloudflareClient, type CloudflareClient } from "../cf/api-client";
import { CloudflareApiError } from "../cf/api-client";
import { getDomainByZoneId, setDomainSendingVia } from "../db/domains";
import { createAlias } from "../db/aliases";
import { provisionDomain } from "./provisioner";
import { preflightZone, verifyDeliveryPath } from "./preflight";
import { publicMxResolvable } from "./watchdog";
import { log } from "../lib/logging";

/**
 * The one button (plan W5/W6, docs/DOMAIN-SETUP-WIZARD-2026-10-25.md): everything between
 * "zone just synced" and "mail arrives and leaves", in one run, server-side. It only ever
 * takes the clean path — no MX takeover, no DMARC takeover, no catch-all replacement —
 * because those are decisions, not conveniences; when one is in the way, the run stops and
 * says exactly which decision is being asked for.
 */

export interface TokenCheck {
  capability: string;
  ok: boolean;
  /** The permission to add when `ok` is false — phrased the way the dashboard phrases it. */
  permission: string;
}

export interface RunStep {
  id: "token" | "receiving" | "alias" | "sending" | "sending-via" | "verify";
  status: "ok" | "skipped" | "blocked" | "failed";
  detail: string;
}

export interface SetupRunResult {
  steps: RunStep[];
  ok: boolean;
}

/**
 * Probe each capability the setup needs, read-only, in parallel (W5).
 *
 * A check fails only on 401/403 — the answer "this token may not". Any other outcome
 * (a 400 from a business rule, a 404 the endpoint itself normalises) means the token
 * COULD call the endpoint, which is all this report is about. Measured lesson: Email
 * Sending permissions exist only at Account level, and a preview called with a name that
 * is not a subdomain of the zone answers 400 — neither is a permission problem, and the
 * first draft of this probe reported both as one.
 */
export async function tokenReport(
  client: CloudflareClient,
  zoneId: string,
  domainName: string,
): Promise<TokenCheck[]> {
  const probe = async (capability: string, permission: string, fn: () => Promise<unknown>): Promise<TokenCheck> => {
    try {
      await fn();
      return { capability, ok: true, permission };
    } catch (err) {
      const status = err instanceof CloudflareApiError ? err.status : undefined;
      if (status === 401 || status === 403) return { capability, ok: false, permission };
      // Not an auth answer — the token reached the endpoint and was refused for other
      // reasons. That is beyond this report's scope.
      return { capability, ok: true, permission };
    }
  };
  return Promise.all([
    probe("zone.read", "Zone → Zone → Read (or the zone in the token's Zone Resources)", () =>
      client.listDnsRecords(zoneId, "MX"),
    ),
    probe("dns.read", "Zone → DNS → Read", () => client.listDnsRecords(zoneId, "TXT")),
    probe("emailRouting.read", "Zone → Email Routing Rules → Edit", () => client.getCatchAll(zoneId)),
    probe("emailSending.read", "Account → Email Sending → Edit", () => client.listSendingDomains(zoneId)),
    // The preview name must be a subdomain of THIS zone for the call to mean anything.
    probe("emailSending.preview", "Account → Email Sending → Edit", () =>
      client.previewSending(zoneId, `probe.${domainName}`),
    ),
  ]);
}

export async function runFullSetup(
  env: Env,
  zoneId: string,
  opts: { primaryLocal?: string; workerName: string },
): Promise<SetupRunResult> {
  const db = env.DB;
  const client = createCloudflareClient({
    token: env.CLOUDFLARE_API_TOKEN!,
    accountId: env.CF_ACCOUNT_ID || undefined,
  });
  const domain = await getDomainByZoneId(db, zoneId);
  if (!domain) throw new Error("domain not found");

  const steps: RunStep[] = [];
  const blocked = (id: RunStep["id"], detail: string): SetupRunResult => {
    steps.push({ id, status: "blocked", detail });
    return { steps, ok: false };
  };

  // 1 — Token: every capability the run needs, before touching anything.
  const checks = await tokenReport(client, zoneId, domain.name);
  const failing = checks.filter((c) => !c.ok);
  steps.push({
    id: "token",
    status: failing.length === 0 ? "ok" : "blocked",
    detail:
      failing.length === 0
        ? "every capability present"
        : `missing: ${failing.map((f) => f.permission).join("; ")}`,
  });
  if (failing.length > 0) return { steps, ok: false };

  // 2 — Receiving: only the clean path; conflicts are decisions for the wizard's ticks.
  const pf = await preflightZone(
    client,
    { zoneId, name: domain.name, status: domain.zoneStatus, type: domain.zoneType },
    opts.workerName,
  );
  if (pf.classification === PreflightClassification.AlreadyConfigured) {
    steps.push({ id: "receiving", status: "skipped", detail: "already configured" });
  } else if (pf.classification === PreflightClassification.ReadyToProvision) {
    const outcome = await provisionDomain(db, client, zoneId, opts.workerName, {});
    steps.push({
      id: "receiving",
      status: outcome.ok ? "ok" : "failed",
      detail: outcome.ok ? "Email Routing on, catch-all pointed here" : (outcome.error ?? "provisioning failed"),
    });
    if (!outcome.ok) return { steps, ok: false };
  } else {
    return blocked(
      "receiving",
      `needs a decision (${pf.classification}): open the wizard's Enable-receiving step with its takeover tick`,
    );
  }

  // 3 — The first alias: without one, every letter to this domain is refused at the door.
  const existing = await db
    .prepare(`SELECT address FROM aliases WHERE domain_id = ?1 AND status = 'ACTIVE' LIMIT 1`)
    .bind(domain.id)
    .first<{ address: string }>();
  if (existing) {
    steps.push({ id: "alias", status: "skipped", detail: existing.address });
  } else {
    const local = (opts.primaryLocal ?? "hello").toLowerCase().replace(/[^a-z0-9._-]/g, "") || "hello";
    const alias = await createAlias(db, {
      domainId: domain.id,
      domainName: domain.name,
      localPart: local,
      label: "Primary",
    });
    steps.push({ id: "alias", status: "ok", detail: alias.address });
  }

  // 4 — Sending: subdomain by default, so the strict DMARC lands where nothing else sends.
  const names = await client.listSendingDomains(zoneId);
  const enabled = names.find((n: { enabled?: boolean }) => n.enabled);
  if (enabled) {
    steps.push({ id: "sending", status: "skipped", detail: String((enabled as { name?: string }).name ?? domain.name) });
  } else {
    const sendName = `send.${domain.name}`;
    const preview = await client.previewSending(zoneId, sendName).catch(() => null);
    const dmarcConflict =
      preview?.errors?.some((e: { code?: string }) => ["dmarc.multiple", "dmarc.incompatible"].includes(e.code ?? "")) ?? false;
    if (dmarcConflict) {
      // A decision, not a convenience: stop here, the rest still works.
      steps.push({
        id: "sending",
        status: "blocked",
        detail: "an existing _dmarc record conflicts — use the sending dialog's DMARC confirmation",
      });
    } else {
      try {
        await client.enableSending(zoneId, sendName);
        steps.push({ id: "sending", status: "ok", detail: `${sendName} (DNS written by Cloudflare)` });
      } catch (err) {
        steps.push({
          id: "sending",
          status: "failed",
          detail: err instanceof CloudflareApiError ? err.message : "enabling failed",
        });
      }
    }
  }

  // 5 — Sending-via: answers leave under the subdomain when one was enabled.
  const fresh = await getDomainByZoneId(db, zoneId);
  if (fresh?.sendingVia) {
    steps.push({ id: "sending-via", status: "skipped", detail: fresh.sendingVia });
  } else {
    const sendName = `send.${domain.name}`;
    await setDomainSendingVia(db, domain.id, sendName);
    steps.push({ id: "sending-via", status: "ok", detail: sendName });
  }

  // 6 — Verify, from inside and out.
  const path = await verifyDeliveryPath(client, zoneId, opts.workerName);
  const dns = await publicMxResolvable(domain.name);
  const delivering = path.routing && path.catchAllOurs;
  steps.push({
    id: "verify",
    status: delivering ? "ok" : "failed",
    detail: delivering
      ? dns === false
        ? "configured, but public DNS does not see the MX yet — registrar or propagation; measure again shortly"
        : "routing verified and public DNS sees the MX"
      : "post-setup verification failed — open the wizard's receiving step",
  });

  log.info("setup_run_complete", { zoneId, ok: steps.every((s) => s.status !== "failed" && s.status !== "blocked") });
  return { steps, ok: steps.every((s) => s.status !== "failed" && s.status !== "blocked") };
}
