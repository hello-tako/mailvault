import { describe, expect, it } from "vitest";
import { PreflightClassification, ConflictType } from "@mailvault/shared";
import { buildSetupNext, type SetupSnapshot } from "../../src/provisioning/setup";

const base: SetupSnapshot = {
  domain: { id: "d1", zoneId: "z1", name: "example.com", mailStatus: "READY", sendingStatus: "ENABLED", sendingVia: "send.example.com" },
  token: { readsZone: true, hint: null },
  receiving: {
    classification: PreflightClassification.AlreadyConfigured,
    conflict: null,
    routing: true,
    catchAllOurs: true,
    mxCloudflare: 3,
    mxForeign: 0,
    mxProviders: [],
  },
  dnsPublic: { resolvable: true },
  sending: { enabled: true, records: [], dmarcConflict: false, unavailableReason: null },
  spf: { count: 1, records: ["v=spf1 include:_spf.mx.cloudflare.net ~all"] },
};

describe("buildSetupNext (the wizard's order of steps)", () => {
  it("says done for a fully set-up domain, minus the one account-level chore", () => {
    expect(buildSetupNext(base)).toEqual(["done-receiving", "queue-subscription"]);
  });

  it("leads with the token when the token cannot even see the zone", () => {
    expect(
      buildSetupNext({ ...base, token: { readsZone: false, hint: "fix me" } }),
    ).toEqual(["fix-token"]);
  });

  it("walks a fresh zone through receiving before sending", () => {
    const next = buildSetupNext({
      ...base,
      domain: { ...base.domain, mailStatus: "DISCOVERED", sendingStatus: "UNKNOWN", sendingVia: null },
      receiving: { ...base.receiving, classification: PreflightClassification.ReadyToProvision, routing: false, catchAllOurs: false },
      sending: { ...base.sending, enabled: false },
    });
    expect(next).toEqual(["enable-receiving", "enable-sending"]);
  });

  it("flags a lapsed registration even while Cloudflare looks healthy", () => {
    const next = buildSetupNext({ ...base, dnsPublic: { resolvable: false } });
    expect(next).toContain("probe-dns");
  });

  it("offers the SPF merge only when there are two to merge and receiving is settled", () => {
    const next = buildSetupNext({
      ...base,
      spf: { count: 2, records: ["v=spf1 a ~all", "v=spf1 include:_spf.mx.cloudflare.net ~all"] },
    });
    expect(next).toContain("spf-merge");
    const duringTakeover = buildSetupNext({
      ...base,
      spf: { count: 2, records: ["a", "b"] },
      receiving: { ...base.receiving, classification: PreflightClassification.MxConflict, conflict: { type: ConflictType.Mx, message: "" } },
    });
    expect(duringTakeover).not.toContain("spf-merge");
  });
});
