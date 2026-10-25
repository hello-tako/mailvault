import type { PreflightResult, ConflictDetails } from "@mailvault/shared";
import { ConflictType, PreflightClassification } from "@mailvault/shared";
import { CloudflareApiError, type CloudflareClient } from "../cf/api-client";
import type { CfEmailRoutingRule } from "../cf/types";
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
  /** Ordinary enabled rules must be a single exact MailVault worker action. */
  routingRulesSafe: boolean;
  routingRuleConflict: { actionType: string | null } | null;
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

function safeRoutingRule(rule: CfEmailRoutingRule, workerName: string): boolean {
  if (rule.enabled !== true) return rule.enabled === false;
  if (!Array.isArray(rule.actions) || rule.actions.length !== 1) return false;
  const action = rule.actions[0];
  if (!action || action.type !== "worker" || !Array.isArray(action.value) || action.value.length !== 1 || action.value[0] !== workerName) return false;
  if (!Array.isArray(rule.matchers) || rule.matchers.length < 1) return false;
  return rule.matchers.every((matcher) => matcher &&
    ((matcher.type === "all" && matcher.field === undefined && matcher.value === undefined) ||
      (matcher.type === "literal" && matcher.field === "to" && typeof matcher.value === "string" && matcher.value.length > 0 && matcher.value.length <= 90)));
}

function routingRuleConflict(rule: CfEmailRoutingRule): { actionType: string | null } {
  const action = Array.isArray(rule.actions) && rule.actions.length === 1 ? rule.actions[0] : null;
  return { actionType: action && ["worker", "forward", "drop"].includes(String(action.type)) ? action.type! : null };
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
  const [mxRecords, routingRes, catchAll, routingRules] = await Promise.all([
    client.listDnsRecords(zoneId, "MX"),
    settle(client.getEmailRoutingStatus(zoneId)),
    client.getCatchAll(zoneId),
    client.listEmailRoutingRules(zoneId),
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
  const ca = catchAll?.actions;
  const catchAllOurs = !!catchAll && catchAll.enabled === true && Array.isArray(ca) && ca.length === 1 &&
    ca[0]?.type === "worker" && Array.isArray(ca[0].value) && ca[0].value.length === 1 && ca[0].value[0] === workerName &&
    Array.isArray(catchAll.matchers) && catchAll.matchers.length === 1 && catchAll.matchers[0]?.type === "all" &&
    catchAll.matchers[0].field === undefined && catchAll.matchers[0].value === undefined;
  const foreignCatchAll = !!catchAll && catchAll.enabled !== false && !catchAllOurs;
  const unsafeRule = routingRules.find((rule) => !safeRoutingRule(rule, workerName));
  return {
    routing,
    catchAllOurs,
    foreignCatchAll,
    catchAllType: ca?.[0]?.type ?? null,
    catchAllValue: ca?.[0]?.value?.[0] ?? null,
    routingRulesSafe: !unsafeRule,
    routingRuleConflict: unsafeRule ? routingRuleConflict(unsafeRule) : null,
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

  if (!path.routingRulesSafe) {
    const conflict: ConflictDetails = {
      type: ConflictType.CatchAll,
      message: "An enabled Email Routing rule may shadow MailVault's catch-all.",
      catchAll: { actionType: path.routingRuleConflict?.actionType ?? undefined },
    };
    return { ...base, classification: PreflightClassification.CatchAllConflict, safeToProvision: false, conflict };
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
