import { describe, expect, it } from "vitest";
import { PreflightClassification } from "@mailvault/shared";
import { CloudflareApiError, type CloudflareClient } from "../../src/cf/api-client";
import { preflightZone } from "../../src/provisioning/preflight";

interface Stub {
  mx?: Array<{ content: string; priority?: number }>;
  routing?: { enabled?: boolean; status?: string };
  routingError?: Error;
  catchAll?: { enabled?: boolean; actions?: Array<{ type: string; value: string[] }>; matchers?: Array<{ type: string; field?: string; value?: string }> } | null;
  rules?: Array<{ id?: string; enabled?: boolean; actions?: Array<{ type?: string; value?: string[] }>; matchers?: Array<{ type?: string; field?: string; value?: string }> }>;
}

const WORKER = "mail-vault";

function stubClient(stub: Stub) {
  const mutations: string[] = [];
  const client = {
    hasToken: true,
    async listAllZones() {
      return [];
    },
    async listDnsRecords() {
      return (stub.mx ?? []).map((r) => ({ id: "x", type: "MX", name: "@", content: r.content, priority: r.priority ?? 10 }));
    },
    async getEmailRoutingStatus() {
      if (stub.routingError) throw stub.routingError;
      return stub.routing ?? {};
    },
    async getEmailRoutingDns() {
      return [];
    },
    async listEmailRoutingRules() {
      return stub.rules ?? [];
    },
    async enableEmailRouting() {
      mutations.push("enableEmailRouting");
    },
    async getCatchAll() {
      return stub.catchAll === undefined ? null : stub.catchAll;
    },
    async setCatchAllWorker() {
      mutations.push("setCatchAllWorker");
    },
  } as unknown as CloudflareClient;
  return { client, mutations };
}

const zone = { zoneId: "z1", name: "example.com", status: "active", type: "full" };

describe("domain preflight safety (section 7)", () => {
  it("classifies a clean, unconfigured zone as READY", async () => {
    const { client, mutations } = stubClient({});
    const r = await preflightZone(client, zone, WORKER);
    expect(r.classification).toBe(PreflightClassification.ReadyToProvision);
    expect(r.safeToProvision).toBe(true);
    expect(mutations).toEqual([]);
  });

  it("never proposes to provision over a third-party provider's MX", async () => {
    const { client, mutations } = stubClient({ mx: [{ content: "aspmx.l.google.com", priority: 1 }] });
    const r = await preflightZone(client, zone, WORKER);
    expect(r.classification).toBe(PreflightClassification.MxConflict);
    expect(r.safeToProvision).toBe(false);
    expect(r.conflict?.mxRecords?.[0]?.exchange).toBe("aspmx.l.google.com");
    expect(mutations).toEqual([]);
  });

  it("flags a foreign catch-all without touching it", async () => {
    const { client, mutations } = stubClient({ catchAll: { enabled: true, actions: [{ type: "worker", value: ["someone-else"] }], matchers: [{ type: "all" }] } });
    const r = await preflightZone(client, zone, WORKER);
    expect(r.classification).toBe(PreflightClassification.CatchAllConflict);
    expect(r.safeToProvision).toBe(false);
    expect(mutations).toEqual([]);
  });

  it("recognizes an already-configured zone (idempotent)", async () => {
    const { client, mutations } = stubClient({
      routing: { enabled: true },
      catchAll: { enabled: true, actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "all" }] },
    });
    const r = await preflightZone(client, zone, WORKER);
    expect(r.classification).toBe(PreflightClassification.AlreadyConfigured);
    expect(r.safeToProvision).toBe(false);
    expect(mutations).toEqual([]);
  });

  it("does not treat explicitly disabled Email Routing with a stale ready status as active", async () => {
    const { client, mutations } = stubClient({
      mx: [{ content: "route1.mx.cloudflare.net", priority: 30 }],
      routing: { enabled: false, status: "ready" },
      catchAll: { enabled: true, actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "all" }] },
    });
    const r = await preflightZone(client, zone, WORKER);
    expect(r.classification).toBe(PreflightClassification.ReadyToProvision);
    expect(mutations).toEqual([]);
  });

  it("does not treat a disabled MailVault catch-all as a working delivery path", async () => {
    const { client, mutations } = stubClient({
      mx: [{ content: "route1.mx.cloudflare.net", priority: 30 }],
      routing: { enabled: true },
      catchAll: { enabled: false, actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "all" }] },
    });
    const r = await preflightZone(client, zone, WORKER);
    expect(r.classification).toBe(PreflightClassification.ReadyToProvision);
    expect(mutations).toEqual([]);
  });

  it("blocks an enabled ordinary rule that forwards before catch-all", async () => {
    const { client, mutations } = stubClient({
      mx: [{ content: "route1.mx.cloudflare.net", priority: 30 }],
      routing: { enabled: true },
      catchAll: { enabled: true, actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "all" }] },
      rules: [{ id: "r-forward", enabled: true, actions: [{ type: "forward", value: ["owner@example.net"] }], matchers: [{ type: "literal", field: "to", value: "vip@example.com" }] }],
    });
    const r = await preflightZone(client, zone, WORKER);
    expect(r.classification).toBe(PreflightClassification.CatchAllConflict);
    expect(r.conflict?.message).toContain("shadow");
    expect(mutations).toEqual([]);
  });

  it("fails closed for an enabled rule with extra actions or unknown shape", async () => {
    const { client } = stubClient({
      mx: [{ content: "route1.mx.cloudflare.net", priority: 30 }],
      routing: { enabled: true },
      catchAll: { enabled: true, actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "all" }] },
      rules: [{ id: "r-ambiguous", enabled: true, actions: [{ type: "worker", value: [WORKER] }, { type: "drop" }], matchers: [{ type: "literal", field: "to", value: "vip@example.com" }] }],
    });
    expect((await preflightZone(client, zone, WORKER)).classification).toBe(PreflightClassification.CatchAllConflict);
  });

  it("gates an inactive zone before any API call", async () => {
    const { client } = stubClient({});
    const r = await preflightZone(client, { ...zone, status: "pending" }, WORKER);
    expect(r.classification).toBe(PreflightClassification.ZoneInactive);
    expect(r.safeToProvision).toBe(false);
  });

  it("derives routing state from DNS when the settings flag is not readable", async () => {
    const { client, mutations } = stubClient({
      mx: [{ content: "route1.mx.cloudflare.net", priority: 36 }],
      catchAll: { enabled: true, actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "all" }] },
      routingError: new CloudflareApiError("permission", "Cloudflare API error: Authentication error", 403, [10000]),
    });
    const r = await preflightZone(client, zone, WORKER);
    expect(r.classification).toBe(PreflightClassification.AlreadyConfigured);
    expect(mutations).toEqual([]);
  });

  it("still reports a clean zone as ready when the settings flag is unreadable", async () => {
    const { client, mutations } = stubClient({
      routingError: new CloudflareApiError("permission", "Cloudflare API error: Authentication error", 403, [10000]),
    });
    const r = await preflightZone(client, zone, WORKER);
    expect(r.classification).toBe(PreflightClassification.ReadyToProvision);
    expect(r.safeToProvision).toBe(true);
    expect(mutations).toEqual([]);
  });

  it("does not swallow non-permission routing read failures", async () => {
    const { client } = stubClient({ routingError: new CloudflareApiError("network", "Cloudflare API request failed (network)") });
    await expect(preflightZone(client, zone, WORKER)).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

describe("exact catch-all and ordinary rule safety", () => {
  const configured = { mx: [{ content: "route1.mx.cloudflare.net", priority: 30 }], routing: { enabled: true },
    catchAll: { enabled: true, actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "all" }] } };

  it.each([
    { actions: [{ type: "worker", value: [WORKER, "other-worker"] }], enabled: true, matchers: [{ type: "all" }] },
    { actions: [{ type: "worker", value: [WORKER] }, { type: "forward", value: ["fixture@example.net"] }], enabled: true, matchers: [{ type: "all" }] },
    { actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "all" }] },
    { actions: [{ type: "worker", value: [WORKER] }], enabled: true },
    { actions: [{ type: "worker", value: [WORKER] }], enabled: true, matchers: [{ type: "literal", field: "to", value: "fixture@example.com" }] },
  ])("rejects malformed or multi-destination catch-all %#", async (catchAll) => {
    const { client } = stubClient({ ...configured, catchAll });
    expect((await preflightZone(client, zone, WORKER)).classification).toBe(PreflightClassification.CatchAllConflict);
  });

  it.each([
    { enabled: true, actions: [{ type: "drop" }], matchers: [{ type: "literal", field: "to", value: "fixture@example.com" }] },
    { enabled: true, actions: [{ type: "worker", value: ["other-worker"] }], matchers: [{ type: "literal", field: "to", value: "fixture@example.com" }] },
    { enabled: true, actions: [{ type: "worker", value: [WORKER, "other-worker"] }], matchers: [{ type: "literal", field: "to", value: "fixture@example.com" }] },
    { actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "all" }] },
    { enabled: true, actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "regex", field: "to", value: "fixture" }] },
    { enabled: true, actions: [{ type: "worker", value: [WORKER] }], matchers: [] },
    { enabled: true, actions: [{ type: "future-action" }], matchers: [{ type: "all" }] },
  ])("rejects shadowing or unknown ordinary rule %#", async (rule) => {
    const { client } = stubClient({ ...configured, rules: [{ id: "unsafe-rule", ...rule }] });
    expect((await preflightZone(client, zone, WORKER)).classification).toBe(PreflightClassification.CatchAllConflict);
  });

  it("allows disabled foreign rules and exact enabled MailVault rules", async () => {
    const { client } = stubClient({ ...configured, rules: [
      { id: "disabled-forward", enabled: false, actions: [{ type: "forward", value: ["fixture@example.net"] }] },
      { id: "safe-rule", enabled: true, actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "literal", field: "to", value: "fixture@example.com" }] },
    ] });
    expect((await preflightZone(client, zone, WORKER)).classification).toBe(PreflightClassification.AlreadyConfigured);
  });
});
