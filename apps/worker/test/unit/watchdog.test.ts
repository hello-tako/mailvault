import { describe, expect, it } from "vitest";
import {
  AuthPolicy,
  CatchAllStatus,
  ConflictType,
  MailStatus,
  RoutingStatus,
  SendingStatus,
  type Domain,
} from "@mailvault/shared";
import { CloudflareApiError, type CloudflareClient } from "../../src/cf/api-client";
import { watchDomains } from "../../src/provisioning/watchdog";

const WORKER = "mail-vault";

function domain(over: Partial<Domain> = {}): Domain {
  return {
    id: "d1",
    cloudflareZoneId: "z1",
    cloudflareAccountId: null,
    name: "example.com",
    zoneStatus: "active",
    zoneType: "full",
    mailStatus: MailStatus.Ready,
    routingStatus: RoutingStatus.Ready,
    catchAllStatus: CatchAllStatus.Ours,
    conflictType: ConflictType.None,
    conflictDetails: null,
    authPolicy: AuthPolicy.Warn,
    sendingStatus: SendingStatus.Unknown,
    sendingVia: null,
    sendingTag: null,
    sendingCheckedAt: null,
    lastCheckedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function stubDb() {
  const writes: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const api: Record<string, unknown> = {
        bind: (...args: unknown[]) => {
          binds = args;
          return api;
        },
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => {
          writes.push({ sql: sql.replace(/\s+/g, " ").trim(), binds });
          return { success: true, meta: {} };
        },
      };
      return api;
    },
    batch: async () => ({ results: [] }),
  };
  return { db: db as unknown as D1Database, writes };
}

interface Stub {
  mx?: Array<{ content: string; priority?: number }>;
  routing?: { enabled?: boolean; status?: string };
  catchAll?: { enabled?: boolean; actions?: Array<{ type: string; value: string[] }>; matchers?: Array<{ type: string; field?: string; value?: string }> } | null;
  /** Thrown by the settings read — how the DNS fallback path is exercised. */
  routingError?: Error;
  rules?: Array<{ id?: string; enabled?: boolean; actions?: Array<{ type?: string; value?: string[] }>; matchers?: Array<{ type?: string; field?: string; value?: string }> }>;
}

function stubClient(stub: Stub) {
  const mutations: string[] = [];
  const client = {
    hasToken: true,
    listAllZones: async () => [],
    listDnsRecords: async () => stub.mx ?? [{ content: "route1.mx.cloudflare.net", priority: 30 }],
    getEmailRoutingStatus: async () => {
      if (stub.routingError) throw stub.routingError;
      return stub.routing ?? { enabled: true };
    },
    getEmailRoutingDns: async () => [],
    listEmailRoutingRules: async () => stub.rules ?? [],
    enableEmailRouting: async () => {
      mutations.push("enableEmailRouting");
    },
    getCatchAll: async () =>
      stub.catchAll === undefined ? { enabled: true, actions: [{ type: "worker", value: [WORKER] }], matchers: [{ type: "all" }] } : stub.catchAll,
    setCatchAllWorker: async () => {
      mutations.push("setCatchAllWorker");
    },
  } as unknown as CloudflareClient;
  return { client, mutations };
}

const statusWrites = (writes: { sql: string; binds: unknown[] }[]) =>
  writes.filter((w) => /UPDATE domains SET mail_status/.test(w.sql));

describe("drift watchdog (read-only against Cloudflare)", () => {
  it("leaves a healthy domain alone apart from its check timestamp", async () => {
    const { client, mutations } = stubClient({});
    const { db, writes } = stubDb();

    const report = await watchDomains(db, client, [domain()], WORKER);

    expect(report.ok).toEqual(["example.com"]);
    expect(report.drifted).toEqual([]);
    expect(mutations).toEqual([]);
    expect(statusWrites(writes)).toEqual([]);
    expect(writes.some((w) => /last_checked_at/.test(w.sql))).toBe(true);
  });

  it("flags a domain whose catch-all moved to another Worker, and names the destination", async () => {
    const { client, mutations } = stubClient({ catchAll: { enabled: true, actions: [{ type: "worker", value: ["someone-else"] }], matchers: [{ type: "all" }] } });
    const { db, writes } = stubDb();

    const report = await watchDomains(db, client, [domain()], WORKER);

    expect(report.drifted).toEqual(["example.com"]);
    expect(mutations).toEqual([]); // never "fixes" a zone by itself
    const write = statusWrites(writes)[0];
    expect(write?.binds).toContain(MailStatus.Conflict);
    expect(write?.binds).toContain(ConflictType.Drift);
    expect(JSON.stringify(write?.binds)).toContain("someone-else");
  });

  it("flags an enabled ordinary rule that shadows the catch-all", async () => {
    const { client } = stubClient({ rules: [{ id: "shadow", enabled: true, actions: [{ type: "forward", value: ["owner@example.net"] }], matchers: [{ type: "literal", field: "to", value: "vip@example.com" }] }] });
    const { db, writes } = stubDb();
    const report = await watchDomains(db, client, [domain()], WORKER);
    expect(report.drifted).toEqual(["example.com"]);
    expect(JSON.stringify(writes)).toContain("enabled Email Routing rule may shadow");
  });

  it("flags a domain that lost its routing MX", async () => {
    // Mirrors production: the settings flag is not token-readable, so routing state is
    // derived from DNS — and DNS no longer publishes Cloudflare's routing MX.
    const { client } = stubClient({
      mx: [],
      routingError: new CloudflareApiError("permission", "Cloudflare API error: Authentication error", 403, [10000]),
    });
    const { db, writes } = stubDb();

    const report = await watchDomains(db, client, [domain()], WORKER);

    expect(report.drifted).toEqual(["example.com"]);
    expect(JSON.stringify(statusWrites(writes)[0]?.binds)).toContain("Email Routing is no longer active");
  });

  it("restores only what it previously marked as drifted", async () => {
    const { client } = stubClient({});
    const { db, writes } = stubDb();
    const drifted = domain({ mailStatus: MailStatus.Conflict, conflictType: ConflictType.Drift });

    const report = await watchDomains(db, client, [drifted], WORKER);

    expect(report.restored).toEqual(["example.com"]);
    expect(statusWrites(writes)[0]?.binds).toContain(MailStatus.Ready);
  });

  it("does not resurrect an MX-conflict domain just because routing looks fine", async () => {
    const { client } = stubClient({});
    const { db, writes } = stubDb();
    const mxConflict = domain({ mailStatus: MailStatus.Conflict, conflictType: ConflictType.Mx });

    const report = await watchDomains(db, client, [mxConflict], WORKER);

    expect(report.restored).toEqual([]);
    expect(statusWrites(writes)).toEqual([]);
  });

  it("treats an unreadable zone as unknown, not as drift", async () => {
    const { client } = stubClient({ routingError: new CloudflareApiError("network", "boom", 500, []) });
    const { db, writes } = stubDb();

    const report = await watchDomains(db, client, [domain()], WORKER);

    expect(report.failed).toEqual(["example.com"]);
    expect(report.drifted).toEqual([]);
    expect(statusWrites(writes)).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain("routing_verified_at = NULL");
  });
});
