import type { Domain, DriftReport } from "@mailvault/shared";
import { CatchAllStatus, ConflictType, MailStatus, RoutingStatus } from "@mailvault/shared";
import type { CloudflareClient } from "../cf/api-client";
import { CloudflareApiError } from "../cf/api-client";
import { clearRoutingVerified, listDomains, markRoutingVerified, patchDomainProvisioning, recordProvisioningEvent } from "../db/domains";
import { log } from "../lib/logging";
import { mapWithConcurrency } from "../lib/util";
import { verifyDeliveryPath } from "./preflight";

const empty = (): DriftReport => ({ checked: 0, ok: [], drifted: [], restored: [], failed: [] });

function driftReason(path: Awaited<ReturnType<typeof verifyDeliveryPath>>, workerName: string): string {
  if (!path.routing) {
    return "Email Routing is no longer active for this domain — Cloudflare's routing MX records are gone from DNS.";
  }
  if (path.catchAllType) {
    return `Unrouted mail now goes to ${path.catchAllType} → ${path.catchAllValue ?? "?"} instead of the ${workerName} Worker.`;
  }
  return `The catch-all rule pointing at ${workerName} was removed.`;
}

async function checkOne(db: D1Database, client: CloudflareClient, d: Domain, workerName: string, report: DriftReport): Promise<void> {
  const path = await verifyDeliveryPath(client, d.cloudflareZoneId, workerName);
  const delivering = path.routing && path.catchAllOurs && path.mx.cloudflareRouting > 0 && path.mx.clearForUs;
  if (delivering && d.zoneStatus === "active" && d.zoneType === "full") {
    await markRoutingVerified(db, d.cloudflareZoneId);
  } else {
    await clearRoutingVerified(db, d.cloudflareZoneId);
  }
  const wasReady = d.mailStatus === MailStatus.Ready;

  if (delivering) {
    // Only resurrect what *we* marked as drift; a domain the owner moved elsewhere (or
    // a conflict MailVault must not touch) keeps whatever state it has.
    if (!wasReady && d.conflictType === ConflictType.Drift) {
      await patchDomainProvisioning(db, d.cloudflareZoneId, {
        mailStatus: MailStatus.Ready,
        routingStatus: RoutingStatus.Ready,
        catchAllStatus: CatchAllStatus.Ours,
        conflictType: ConflictType.None,
        conflictDetails: null,
      });
      await recordProvisioningEvent(db, d.id, "watchdog:restored", "READY");
      log.info("domain_drift_restored", { zoneId: d.cloudflareZoneId });
      report.restored.push(d.name);
      return;
    }
    await patchDomainProvisioning(db, d.cloudflareZoneId, {});
    report.ok.push(d.name);
    return;
  }

  if (!wasReady) {
    await patchDomainProvisioning(db, d.cloudflareZoneId, {});
    return;
  }

  const message = driftReason(path, workerName);
  await patchDomainProvisioning(db, d.cloudflareZoneId, {
    mailStatus: MailStatus.Conflict,
    routingStatus: path.routing ? RoutingStatus.Ready : RoutingStatus.Misconfigured,
    catchAllStatus: path.catchAllOurs ? CatchAllStatus.Ours : CatchAllStatus.Foreign,
    conflictType: ConflictType.Drift,
    conflictDetails: { type: ConflictType.Drift, message },
  });
  await recordProvisioningEvent(db, d.id, "watchdog:drift", "CONFLICT", {
    routing: path.routing,
    catchAllOurs: path.catchAllOurs,
  });
  log.warn("domain_drift", { zoneId: d.cloudflareZoneId, routing: path.routing, catchAllOurs: path.catchAllOurs });
  report.drifted.push(d.name);
}

/** Re-verify an explicit set of domains. Read-only against Cloudflare; writes D1 only. */
export async function watchDomains(
  db: D1Database,
  client: CloudflareClient,
  domains: Domain[],
  workerName: string,
): Promise<DriftReport> {
  const report = { ...empty(), checked: domains.length };
  await mapWithConcurrency(domains, 4, async (d) => {
    try {
      await checkOne(db, client, d, workerName, report);
    } catch (err) {
      // An unreadable zone is not evidence of drift — leave its state untouched and
      // say so, rather than downgrading a domain on a transient API failure.
      report.failed.push(d.name);
      log.warn("watchdog_check_failed", {
        zoneId: d.cloudflareZoneId,
        kind: err instanceof CloudflareApiError ? err.kind : "error",
      });
    }
  });
  return report;
}

/** Everything MailVault believes can receive mail, plus anything it flagged as drifted. */
export async function runWatchdog(db: D1Database, client: CloudflareClient, workerName: string): Promise<DriftReport> {
  const tracked = (await listDomains(db)).filter(
    (d) => d.mailStatus === MailStatus.Ready || d.conflictType === ConflictType.Drift,
  );
  if (tracked.length === 0) return empty();
  return watchDomains(db, client, tracked, workerName);
}
