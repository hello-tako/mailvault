import type { ConflictDetails } from "@mailvault/shared";
import { PreflightClassification } from "@mailvault/shared";

/**
 * The one-screen diagnosis behind the Mail Setup wizard (plan W1,
 * docs/DOMAIN-SETUP-WIZARD-2026-10-25.md): everything the owner needs to know about one
 * zone's mail readiness — receiving, sending, DNS as the internet sees it, and whether the
 * API token can act — reduced to an ordered list of next actions. Read-only against
 * Cloudflare; the wizard's buttons call the existing mutation routes.
 */

export interface SetupSnapshot {
  domain: {
    id: string;
    zoneId: string;
    name: string;
    mailStatus: string;
    sendingStatus: string;
    sendingVia: string | null;
  };
  token: { readsZone: boolean; hint: string | null };
  receiving: {
    classification: PreflightClassification;
    conflict: ConflictDetails | null;
    routing: boolean;
    catchAllOurs: boolean;
    mxCloudflare: number;
    mxForeign: number;
    mxProviders: string[];
  };
  dnsPublic: { resolvable: boolean | null };
  sending: {
    enabled: boolean;
    records: Array<Record<string, unknown>>;
    dmarcConflict: boolean;
    unavailableReason: string | null;
  };
  spf: { count: number; records: string[] };
}

export type SetupAction =
  | "fix-token"
  | "enable-receiving"
  | "enable-sending"
  | "choose-sending-via"
  | "queue-subscription"
  | "spf-merge"
  | "probe-dns"
  | "done-receiving";

/** Pure: the ordered next steps for a snapshot — unit-tested, the route only wires data. */
export function buildSetupNext(s: SetupSnapshot): SetupAction[] {
  const next: SetupAction[] = [];
  if (!s.token.readsZone) {
    next.push("fix-token");
    return next; // nothing else can be trusted or done until the token can see the zone
  }
  const needsReceiving =
    s.receiving.classification === PreflightClassification.ReadyToProvision ||
    s.receiving.classification === PreflightClassification.MxConflict ||
    s.receiving.classification === PreflightClassification.CatchAllConflict;
  if (needsReceiving) next.push("enable-receiving");
  else if (s.receiving.classification === PreflightClassification.AlreadyConfigured) {
    next.push("done-receiving");
    if (s.dnsPublic.resolvable === false) next.push("probe-dns");
  }
  if (!s.sending.enabled) next.push("enable-sending");
  else if (!s.domain.sendingVia) next.push("choose-sending-via");
  if (s.sending.enabled) next.push("queue-subscription");
  if (s.spf.count >= 2 && !needsReceiving) next.push("spf-merge");
  return next;
}
