import type { Domain, DriftReport } from "@mailvault/shared";
import { CatchAllStatus, ConflictType, MailStatus, RoutingStatus } from "@mailvault/shared";
import type { CloudflareClient } from "../cf/api-client";
import { CloudflareApiError } from "../cf/api-client";
import { listDomains, patchDomainProvisioning, recordProvisioningEvent } from "../db/domains";
import { log } from "../lib/logging";
import { mapWithConcurrency } from "../lib/util";
import { verifyDeliveryPath } from "./preflight";

const empty = (): DriftReport => ({ checked: 0, ok: [], drifted: [], restored: [], failed: [] });

/**
 * Ask a public resolver whether the world can see this domain's MX at all — the one fact
 * no Cloudflare API call can give. Cloudflare's zone can be active and Email Routing
 * perfectly configured while the registration lapsed and the name answers NXDOMAIN
 * everywhere else (loiyeuthuong.org, 2026-10). DoH over JSON keeps it one plain fetch.
 *
 * `null` means the probe itself could not answer, which is never evidence about the domain.
 */
async function publicMxResolvable(name: string): Promise<boolean | null> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=MX`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { Status?: number; Answer?: { type: number }[] };
    if (json.Status === 3) return false; // NXDOMAIN: the name itself is gone
    return (json.Answer ?? []).some((a) => a.type === 15); // 15 = MX
  } catch {
    return null;
  }
}

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
  const delivering = path.routing && path.catchAllOurs;
  const wasReady = d.mailStatus === MailStatus.Ready;

  if (delivering) {
    // The inside view can be perfect while the outside world cannot resolve the name at
    // all — a lapsed registration looks healthy to every Cloudflare API. Only domains we
    // believe can receive mail are probed, so the hourly cost stays at one DoH query each.
    if (wasReady || d.conflictType === ConflictType.Drift) {
      const publicMx = await publicMxResolvable(d.name);
      if (publicMx === false) {
        const message =
          "Public resolvers cannot see this domain or its MX — the registration may have " +
          "lapsed. Cloudflare still shows the zone as healthy, so only senders' logs will " +
          "say; check the registrar before relying on this address.";
        await patchDomainProvisioning(db, d.cloudflareZoneId, {
          mailStatus: MailStatus.Conflict,
          conflictType: ConflictType.DnsUnresolvable,
          conflictDetails: { type: ConflictType.DnsUnresolvable, message },
        });
        await recordProvisioningEvent(db, d.id, "watchdog:dns_unresolvable", "CONFLICT", {
          domain: d.name,
        });
        log.warn("domain_dns_unresolvable", { zoneId: d.cloudflareZoneId, domain: d.name });
        report.drifted.push(d.name);
        return;
      }
    }
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
