import type { ConflictDetails, Domain, PreflightResult, ProvisionOutcome } from "@mailvault/shared";
import {
  CatchAllStatus,
  ConflictType,
  MailStatus,
  PreflightClassification,
  RoutingStatus,
} from "@mailvault/shared";
import type { CloudflareClient } from "../cf/api-client";
import { CloudflareApiError } from "../cf/api-client";
import { forbidden } from "../lib/errors";
import { getDomainByZoneId, patchDomainProvisioning, recordProvisioningEvent } from "../db/domains";
import { log } from "../lib/logging";
import { mapWithConcurrency, newId } from "../lib/util";
import { preflightZone, verifyDeliveryPath } from "./preflight";
import { assessMx } from "./mx";

export interface ProvisionOptions {
  /** Owner explicitly confirmed replacing a foreign catch-all. */
  allowCatchAllTakeover?: boolean;
  /** Owner explicitly confirmed deleting another provider's MX records on this domain. */
  allowMxTakeover?: boolean;
  /** Called only after a fresh live read confirms a foreign MX/catch-all before overwrite. */
  authorizeTakeover?: (
    operation: "provision.mx-takeover" | "provision.catch-all-takeover",
  ) => Promise<void>;
  /**
   * Domains the owner has ruled out (they serve another mail product). Nothing is
   * mutated for them regardless of the takeover flags.
   */
  denyDomains?: string[];
}

interface Step {
  step: string;
  ok: boolean;
  detail?: string | null;
}

/**
 * Delete the MX records belonging to another provider, writing them to the event log first
 * so the domain can be handed back. Matching is by record type and normalised exchange, so
 * Cloudflare's own routing MX can never be caught here even when a zone has both.
 *
 * Deliberately narrow, and measured on a real takeover (abitovn.info, 2026-09-20):
 * enabling Email Routing added its MX and its DKIM record but did NOT add a second SPF, so
 * the provider's `v=spf1 include:_spf-us.ionos.com ~all` was left as the only SPF. Deleting
 * it would have bought nothing for inbound and silently broken anything the owner still
 * sends through the old provider. DKIM and `_dmarc` are left alone for the same reason.
 */
async function removeForeignMx(
  db: D1Database,
  client: CloudflareClient,
  domain: Domain,
  authorizeTakeover: ProvisionOptions["authorizeTakeover"],
): Promise<string[]> {
  const zoneId = domain.cloudflareZoneId;
  const records = await client.listDnsRecords(zoneId, "MX");
  const candidates = records.filter((r) => r.type === "MX" && !assessMx([r]).clearForUs);
  const removed: string[] = [];

  for (const rec of candidates) {
    const latest = await client.listDnsRecords(zoneId, "MX");
    const stillForeign =
      latest.some((current) => current.id === rec.id) &&
      assessMx(latest).foreign.some(
        (current) =>
          current.exchange.toLowerCase() === rec.content.trim().replace(/\.$/, "").toLowerCase(),
      );
    if (!stillForeign) continue;
    if (!authorizeTakeover)
      throw forbidden("Unlock with your passkey first", { stepUpRequired: true });
    await authorizeTakeover("provision.mx-takeover");
    const removing = [
      {
        id: rec.id,
        type: rec.type,
        name: rec.name,
        content: rec.content,
        priority: Number(rec.priority ?? 0),
      },
    ];
    await recordProvisioningEvent(db, domain.id, "provision:mx_takeover", "RUNNING", { removing });
    await client.deleteDnsRecord(zoneId, rec.id);
    removed.push(`MX ${rec.content}`);
  }
  if (removed.length)
    log.warn("domain_mx_removed", { domain: domain.name, zoneId, count: removed.length });
  return removed;
}

function isForeignCatchAll(
  rule: Awaited<ReturnType<CloudflareClient["getCatchAll"]>>,
  workerName: string,
): boolean {
  const action = rule?.actions?.[0];
  return (
    !!rule &&
    rule.enabled !== false &&
    !!action &&
    action.type !== "drop" &&
    !(action.type === "worker" && action.value?.[0] === workerName)
  );
}

/**
 * Idempotent provisioning state machine (section 8). Runs only after an explicit,
 * authenticated owner action — never on startup. Another provider's MX is removed only
 * when the owner asked for exactly that (`allowMxTakeover`), and every record is written
 * to the domain's event log first so it can be put back. Domains the owner ruled out are
 * refused whatever the flags say.
 */
export async function provisionDomain(
  db: D1Database,
  client: CloudflareClient,
  zoneId: string,
  workerName: string,
  opts: ProvisionOptions = {},
): Promise<ProvisionOutcome> {
  const domain = await getDomainByZoneId(db, zoneId);
  if (!domain) {
    return outcome(
      zoneId,
      "",
      null,
      MailStatus.Failed,
      false,
      "Domain not synced yet — run Sync first",
      [],
    );
  }
  const steps: Step[] = [];

  const denied = (opts.denyDomains ?? []).some(
    (d) => d.trim().toLowerCase() === domain.name.toLowerCase(),
  );
  if (denied) {
    await recordProvisioningEvent(db, domain.id, "provision:denied", "BLOCKED", {
      reason: "excluded by owner",
    });
    return outcome(
      zoneId,
      domain.name,
      domain.id,
      MailStatus.Conflict,
      false,
      `${domain.name} is excluded from MailVault management — nothing was changed`,
      steps,
    );
  }

  await patchDomainProvisioning(db, zoneId, { mailStatus: MailStatus.Provisioning });
  await recordProvisioningEvent(db, domain.id, "provision:start", "RUNNING");

  try {
    const pf = await preflightZone(
      client,
      { zoneId, name: domain.name, status: domain.zoneStatus, type: domain.zoneType },
      workerName,
    );
    const hasLivePath = new Set<PreflightClassification>([
      PreflightClassification.MxConflict,
      PreflightClassification.CatchAllConflict,
      PreflightClassification.ReadyToProvision,
      PreflightClassification.AlreadyConfigured,
    ]).has(pf.classification);
    const livePath = hasLivePath ? await verifyDeliveryPath(client, zoneId, workerName) : null;
    const liveMxConflict = (livePath?.mx.foreign.length ?? 0) > 0;
    const liveCatchAllConflict = livePath?.foreignCatchAll ?? false;
    const classification = livePath
      ? liveMxConflict
        ? PreflightClassification.MxConflict
        : liveCatchAllConflict
          ? PreflightClassification.CatchAllConflict
          : livePath.routing && livePath.catchAllOurs
            ? PreflightClassification.AlreadyConfigured
            : PreflightClassification.ReadyToProvision
      : pf.classification;
    const mxTakeover =
      classification === PreflightClassification.MxConflict && opts.allowMxTakeover === true;
    if (
      ((liveMxConflict && opts.allowMxTakeover) ||
        (liveCatchAllConflict && opts.allowCatchAllTakeover)) &&
      !opts.authorizeTakeover
    ) {
      throw forbidden("Unlock with your passkey first", { stepUpRequired: true });
    }
    if (
      (liveMxConflict && !opts.allowMxTakeover) ||
      (liveCatchAllConflict && !opts.allowCatchAllTakeover)
    ) {
      const conflict: ConflictDetails = liveMxConflict
        ? {
            type: ConflictType.Mx,
            message: `Existing MX detected (${livePath?.mx.providers.join(", ") || "unrecognized provider"}).`,
            mxRecords: livePath?.mx.foreign.map((r) => ({
              exchange: r.exchange,
              priority: r.priority,
            })),
          }
        : {
            type: ConflictType.CatchAll,
            message: "A foreign catch-all rule is still configured.",
            catchAll: {
              actionType: livePath?.catchAllType ?? undefined,
              destination: livePath?.catchAllValue ?? undefined,
            },
          };
      await patchDomainProvisioning(db, zoneId, {
        mailStatus: MailStatus.Conflict,
        conflictType: conflict.type,
        conflictDetails: conflict,
      });
      await recordProvisioningEvent(db, domain.id, "provision:live_conflict", "CONFLICT", conflict);
      return outcome(
        zoneId,
        domain.name,
        domain.id,
        MailStatus.Conflict,
        false,
        conflict.message,
        steps,
      );
    }

    // Allow-list gate: mutate ONLY for classifications we have positively cleared, plus the
    // two conflicts the owner has just confirmed taking over. Anything else — an
    // inactive/unsupported zone, and especially a permission/auth error from a preflight
    // read — stops here. A token that cannot *see* the zone must never be allowed to
    // *change* it (section 7/9).
    const provisionable =
      classification === PreflightClassification.ReadyToProvision ||
      classification === PreflightClassification.AlreadyConfigured ||
      (classification === PreflightClassification.CatchAllConflict &&
        opts.allowCatchAllTakeover === true) ||
      mxTakeover;
    if (!provisionable) {
      await patchDomainProvisioning(db, zoneId, {
        mailStatus: pf.conflict ? MailStatus.Conflict : MailStatus.Failed,
        conflictType: pf.conflict?.type ?? ConflictType.None,
        conflictDetails: pf.conflict ?? null,
      });
      await recordProvisioningEvent(db, domain.id, "provision:blocked", "BLOCKED", {
        classification,
      });
      return outcome(
        zoneId,
        domain.name,
        domain.id,
        MailStatus.Failed,
        false,
        `Not safe to provision (${classification})`,
        steps,
      );
    }

    if (mxTakeover) {
      const removed = await removeForeignMx(db, client, domain, opts.authorizeTakeover);
      steps.push({
        step: "mx_takeover",
        ok: true,
        detail: removed.length ? `removed ${removed.join("; ")}` : "nothing to remove",
      });
    }

    const skipDns = classification === PreflightClassification.AlreadyConfigured;

    // ensureEmailRoutingDns — adds+locks CF MX/SPF + enables. Skipped when the zone
    // already publishes Cloudflare's routing MX: re-enabling is a redundant mutation and
    // a needless write against a live zone.
    let routingOn = skipDns;
    if (!routingOn) {
      let mxNow = await client.listDnsRecords(zoneId, "MX");
      if (assessMx(mxNow).foreign.length > 0) {
        if (!opts.allowMxTakeover) {
          return outcome(
            zoneId,
            domain.name,
            domain.id,
            MailStatus.Conflict,
            false,
            "Foreign MX records appeared during provisioning",
            steps,
          );
        }
        await removeForeignMx(db, client, domain, opts.authorizeTakeover);
        mxNow = await client.listDnsRecords(zoneId, "MX");
        if (assessMx(mxNow).foreign.length > 0) {
          return outcome(
            zoneId,
            domain.name,
            domain.id,
            MailStatus.Conflict,
            false,
            "MX records changed during takeover; nothing further was changed",
            steps,
          );
        }
      }
      routingOn = assessMx(mxNow).cloudflareRouting > 0;
    }

    if (routingOn) {
      steps.push({
        step: "email_routing_dns",
        ok: true,
        detail: skipDns ? "already enabled" : "mx present",
      });
    } else {
      await client.enableEmailRouting(zoneId);
      steps.push({ step: "email_routing_dns", ok: true });
    }
    await patchDomainProvisioning(db, zoneId, { mailStatus: MailStatus.Provisioning });

    const currentCatchAll = await client.getCatchAll(zoneId);
    if (isForeignCatchAll(currentCatchAll, workerName)) {
      if (!opts.allowCatchAllTakeover) {
        return outcome(
          zoneId,
          domain.name,
          domain.id,
          MailStatus.Conflict,
          false,
          "A foreign catch-all appeared during provisioning",
          steps,
        );
      }
      if (!opts.authorizeTakeover)
        throw forbidden("Unlock with your passkey first", { stepUpRequired: true });
      await opts.authorizeTakeover("provision.catch-all-takeover");
    }

    // ensureCatchAllWorkerRule — PUT catch_all -> our worker. Idempotent (sets ours).
    await client.setCatchAllWorker(zoneId, workerName);
    steps.push({
      step: "catch_all_worker",
      ok: true,
      detail:
        opts.allowCatchAllTakeover && classification === PreflightClassification.CatchAllConflict
          ? "took over foreign catch-all"
          : null,
    });
    await patchDomainProvisioning(db, zoneId, { mailStatus: MailStatus.Verifying });

    // verify (section 33) — do not claim READY off a single 200. Re-read the whole
    // delivery path with the same judgement the watchdog uses.
    const verified = await verifyDeliveryPath(client, zoneId, workerName);
    const routingOk = verified.routing;
    const catchAllOk = verified.catchAllOurs;
    steps.push({
      step: "verify",
      ok: routingOk && catchAllOk,
      detail: `routing=${routingOk} catch_all=${catchAllOk}`,
    });

    const routingStatus = routingOk ? RoutingStatus.Ready : RoutingStatus.Misconfigured;
    const catchAllStatus = catchAllOk ? CatchAllStatus.Ours : CatchAllStatus.Foreign;

    if (routingOk && catchAllOk) {
      await patchDomainProvisioning(db, zoneId, {
        mailStatus: MailStatus.Ready,
        routingStatus,
        catchAllStatus,
        conflictType: ConflictType.None,
        conflictDetails: null,
      });
      await recordProvisioningEvent(db, domain.id, "provision:ready", "READY");
      log.info("domain_ready", { zoneId });
      return outcome(zoneId, domain.name, domain.id, MailStatus.Ready, true, null, steps);
    }

    await patchDomainProvisioning(db, zoneId, {
      mailStatus: MailStatus.Failed,
      routingStatus,
      catchAllStatus,
    });
    await recordProvisioningEvent(db, domain.id, "provision:verify_failed", "FAILED");
    return outcome(
      zoneId,
      domain.name,
      domain.id,
      MailStatus.Failed,
      false,
      "Post-provision verification failed",
      steps,
    );
  } catch (err) {
    if (
      err instanceof Error &&
      "status" in err &&
      err.status === 403 &&
      "details" in err &&
      typeof err.details === "object" &&
      err.details !== null &&
      "stepUpRequired" in err.details &&
      err.details.stepUpRequired === true
    )
      throw err;
    const kind = err instanceof CloudflareApiError ? err.kind : "error";
    const message = err instanceof CloudflareApiError ? err.message : "Provisioning error";
    if (err instanceof CloudflareApiError) {
      log.warn("provision_step_failed", {
        zoneId,
        path: err.path ?? null,
        kind: err.kind,
        status: err.status ?? null,
        cfCodes: err.cfCodes ?? null,
        completedSteps: steps.map((s) => s.step),
      });
    }
    await patchDomainProvisioning(db, zoneId, {
      mailStatus: MailStatus.Failed,
      conflictType: ConflictType.None,
      conflictDetails: null,
    });
    await recordProvisioningEvent(db, domain.id, "provision:error", "FAILED", { kind });
    log.error("domain_provision_failed", { zoneId, kind });

    // Two measured shapes of this failure. `enable` succeeds with an API token when the
    // zone is inside its Zone Resources, and Cloudflare answers 403 / cfCode 10000 — the
    // same code it uses for a missing permission — when it is not. On 2026-09-20 a token
    // that deleted DNS records on a zone was still refused `enable` on that same zone, so
    // the permission itself can be the gap: name both, and say what happens to the MX.
    const enablePath =
      err instanceof CloudflareApiError && /\/email\/routing\/(enable|dns)$/.test(err.path ?? "");
    const mxAlreadyGone = steps.some((s) => s.step === "mx_takeover");
    const actionable =
      enablePath && (kind === "permission" || kind === "auth")
        ? "Email Routing is not enabled for this domain, and MailVault's API token was refused when it tried. " +
          "The token needs Zone → Email Routing Rules → Edit, and its Zone Resources set to 'All zones from an " +
          "account' — Cloudflare reports both problems with this same auth error. Enabling Email Routing once for " +
          "the zone in the Cloudflare dashboard also works; MailVault will then set the catch-all and verify. " +
          (mxAlreadyGone
            ? "Note: this domain's previous MX records were already removed for the take-over you confirmed, so " +
              "inbound mail has nowhere to go until routing is enabled. The removed records are in the domain's " +
              "event log."
            : "No MX record was touched.")
        : message;

    return outcome(zoneId, domain.name, domain.id, MailStatus.Failed, false, actionable, steps);
  }
}

function outcome(
  zoneId: string,
  name: string,
  domainId: string | null,
  status: MailStatus,
  ok: boolean,
  error: string | null,
  steps: Step[],
): ProvisionOutcome {
  return { domainId: domainId ?? "", zoneId, name, status, ok, error, steps };
}

/**
 * Verdicts safe to remember on the domain row. Classifications Cloudflare refused
 * (inactive zone, unsupported type, permission error) are deliberately absent: an
 * unreadable zone must not be rewritten into a different state.
 */
const PREFLIGHT_VERDICT: Partial<
  Record<PreflightClassification, { status: MailStatus; conflict: ConflictType }>
> = {
  [PreflightClassification.MxConflict]: { status: MailStatus.Conflict, conflict: ConflictType.Mx },
  [PreflightClassification.CatchAllConflict]: {
    status: MailStatus.Conflict,
    conflict: ConflictType.CatchAll,
  },
  [PreflightClassification.ReadyToProvision]: {
    status: MailStatus.Preflight,
    conflict: ConflictType.None,
  },
  [PreflightClassification.AlreadyConfigured]: {
    status: MailStatus.Ready,
    conflict: ConflictType.None,
  },
};

/**
 * Store a read-only verdict on MailVault's own row so the conflict a preflight found
 * survives a page reload instead of collapsing back to "Not configured". This writes to
 * D1 only — no Cloudflare mutation.
 */
async function rememberVerdict(db: D1Database, domain: Domain, pf: PreflightResult): Promise<void> {
  const verdict = PREFLIGHT_VERDICT[pf.classification];
  const zoneId = domain.cloudflareZoneId;
  if (!verdict) {
    await patchDomainProvisioning(db, zoneId, {});
    return;
  }
  await patchDomainProvisioning(db, zoneId, {
    mailStatus: verdict.status,
    conflictType: verdict.conflict,
    conflictDetails: pf.conflict ?? null,
  });
}

/** Bulk preflight — independent per-domain results (section 32). */
export async function preflightMany(
  db: D1Database,
  client: CloudflareClient,
  zoneIds: string[],
  workerName: string,
): Promise<PreflightResult[]> {
  return mapWithConcurrency(zoneIds, 4, async (zoneId) => {
    const domain = await getDomainByZoneId(db, zoneId);
    if (!domain) {
      return {
        zoneId,
        name: zoneId,
        domainId: null,
        classification: PreflightClassification.ApiPermissionError,
        safeToProvision: false,
        conflict: null,
        checkedAt: new Date().toISOString(),
      } as PreflightResult;
    }
    const pf = await preflightZone(
      client,
      { zoneId, name: domain.name, status: domain.zoneStatus, type: domain.zoneType },
      workerName,
    );
    await rememberVerdict(db, domain, pf);
    return { ...pf, domainId: domain.id };
  });
}

/** Bulk provision — one failure never aborts the others; per-domain receipts. */
export async function provisionMany(
  db: D1Database,
  client: CloudflareClient,
  zoneIds: string[],
  workerName: string,
  opts: ProvisionOptions = {},
): Promise<ProvisionOutcome[]> {
  return mapWithConcurrency(zoneIds, 3, (zoneId) =>
    provisionDomain(db, client, zoneId, workerName, opts),
  );
}

export function newRunId(): string {
  return newId();
}
