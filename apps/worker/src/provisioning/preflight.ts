import type { PreflightResult, ConflictDetails } from "@mailvault/shared";
import { ConflictType, PreflightClassification } from "@mailvault/shared";
import { CloudflareApiError, type CloudflareClient } from "../cf/api-client";
import { log } from "../lib/logging";
import { nowIso } from "../lib/util";
import { assessMx, type MxAssessment } from "./mx";

export interface PreflightZoneInput {
  zoneId: string;
  name: string;
  status: string;
  type: string;
}

/** What the delivery-path reads prove about one zone, right now. */
export interface DeliveryPath {
  routing: boolean;
  catchAllOurs: boolean;
  /** A catch-all rule exists, is enabled, and points somewhere other than us. */
  foreignCatchAll: boolean;
  catchAllType: string | null;
  catchAllValue: string | null;
  mx: MxAssessment;
}

type Settled<T> = { ok: true; value: T } | { ok: false; err: unknown };

/** Run one read without letting it reject its Promise.all siblings. */
async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, err };
  }
}

function isDenied(err: unknown): boolean {
  return err instanceof CloudflareApiError && (err.kind === "auth" || err.kind === "permission");
}

/**
 * Read-only verification of one zone's delivery path: is mail for this zone still
 * arriving at `workerName`? Shared by preflight and the drift watchdog so the two can
 * never disagree about what "configured" means. Performs NO mutation.
 */
export async function verifyDeliveryPath(
  client: CloudflareClient,
  zoneId: string,
  workerName: string,
): Promise<DeliveryPath> {
  const [mxRecords, routingRes, catchAll] = await Promise.all([
    client.listDnsRecords(zoneId, "MX"),
    settle(client.getEmailRoutingStatus(zoneId)),
    client.getCatchAll(zoneId),
  ]);
  const mx = assessMx(mxRecords);
  let routing: boolean;
  if (routingRes.ok) {
    routing = routingRes.value.enabled === true || (routingRes.value.enabled !== false && /ready/i.test(routingRes.value.status ?? ""));
  } else if (isDenied(routingRes.err)) {
    // Re-measured after widening the token's Zone Resources: `POST .../enable` then
    // works, but this settings read still 403s — no API-token permission covers it.
    // Fall back to the observable truth in DNS: Cloudflare only publishes
    // route*.mx.cloudflare.net records once Email Routing is on for the zone.
    log.warn("verify_routing_settings_unreadable", { zoneId, fallback: "mx" });
    routing = mx.cloudflareRouting > 0;
  } else {
    throw routingRes.err;
  }
  const ca = catchAll?.actions?.[0];
  const catchAllOurs = !!ca && catchAll?.enabled !== false && ca.type === "worker" && ca.value?.[0] === workerName;
  const foreignCatchAll = !!catchAll && catchAll.enabled !== false && !!ca && !catchAllOurs && ca.type !== "drop";
  return {
    routing,
    catchAllOurs,
    foreignCatchAll,
    catchAllType: ca?.type ?? null,
    catchAllValue: ca?.value?.[0] ?? null,
    mx,
  };
}

function classifyError(err: unknown): PreflightResult | null {
  if (err instanceof CloudflareApiError) {
    if (err.kind === "auth" || err.kind === "permission") {
      return {
        zoneId: "",
        name: "",
        domainId: null,
        classification: PreflightClassification.ApiPermissionError,
        safeToProvision: false,
        conflict: null,
        checkedAt: nowIso(),
      };
    }
  }
  return null;
}

/**
 * Read-only preflight (section 7). Performs NO mutation. Returns a classification
 * plus the evidence needed to render conflict UI (existing MX / foreign catch-all).
 */
export async function preflightZone(
  client: CloudflareClient,
  zone: PreflightZoneInput,
  workerName: string,
): Promise<PreflightResult> {
  const base = { zoneId: zone.zoneId, name: zone.name, domainId: null as string | null, checkedAt: nowIso() };

  // Cheap, DNS-independent gates first.
  if (zone.status !== "active") {
    return { ...base, classification: PreflightClassification.ZoneInactive, safeToProvision: false, conflict: null };
  }
  if (zone.type !== "full") {
    return { ...base, classification: PreflightClassification.UnsupportedZone, safeToProvision: false, conflict: null };
  }

  let path: DeliveryPath;
  try {
    path = await verifyDeliveryPath(client, zone.zoneId, workerName);
  } catch (err) {
    // Read-only diagnostics: which Cloudflare response made us stop. Safe fields only
    // (no headers, no token) — see lib/logging.
    if (err instanceof CloudflareApiError) {
      log.warn("preflight_read_failed", {
        zoneId: zone.zoneId,
        path: err.path ?? null,
        kind: err.kind,
        status: err.status ?? null,
        cfCodes: err.cfCodes ?? null,
        detail: err.message.slice(0, 200),
      });
    }
    const mapped = classifyError(err);
    if (mapped) return { ...mapped, zoneId: zone.zoneId, name: zone.name };
    throw err;
  }
  const assessed = path.mx;

  if (!assessed.clearForUs) {
    const conflict: ConflictDetails = {
      type: ConflictType.Mx,
      message: `Existing MX detected (${assessed.providers.join(", ") || "unrecognized provider"}).`,
      mxRecords: assessed.foreign.map((f) => ({ exchange: f.exchange, priority: f.priority })),
    };
    return { ...base, classification: PreflightClassification.MxConflict, safeToProvision: false, conflict };
  }

  if (path.foreignCatchAll) {
    const conflict: ConflictDetails = {
      type: ConflictType.CatchAll,
      message: `Catch-all already routes to ${path.catchAllType === "worker" ? "a different Worker" : "another destination"}.`,
      catchAll: { actionType: path.catchAllType ?? undefined, destination: path.catchAllValue ?? undefined },
    };
    return { ...base, classification: PreflightClassification.CatchAllConflict, safeToProvision: false, conflict };
  }

  if (path.routing && path.catchAllOurs) {
    return { ...base, classification: PreflightClassification.AlreadyConfigured, safeToProvision: false, conflict: null };
  }

  return { ...base, classification: PreflightClassification.ReadyToProvision, safeToProvision: true, conflict: null };
}
