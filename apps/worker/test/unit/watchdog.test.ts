import { afterEach, describe, expect, it, vi } from "vitest";

// The watchdog now also asks a public resolver about every domain it believes can receive
// mail; a unit test must never depend on what the real internet says about example.com.
afterEach(() => vi.unstubAllGlobals());

const publicMxAnswer = () =>
  Promise.resolve(
    new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }), {
      status: 200,
      headers: { "content-type": "application/dns-json" },
    }),
  );
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
  catchAll?: { enabled?: boolean; actions?: Array<{ type: string; value: string[] }> } | null;
  /** Thrown by the settings read — how the DNS fallback path is exercised. */
  routingError?: Error;
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
    enableEmailRouting: async () => {
      mutations.push("enableEmailRouting");
    },
    getCatchAll: async () =>
      stub.catchAll === undefined ? { enabled: true, actions: [{ type: "worker", value: [WORKER] }] } : stub.catchAll,
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
    vi.stubGlobal("fetch", vi.fn(async () => publicMxAnswer()));
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
    const { client, mutations } = stubClient({ catchAll: { enabled: true, actions: [{ type: "worker", value: ["someone-else"] }] } });
    const { db, writes } = stubDb();

    const report = await watchDomains(db, client, [domain()], WORKER);

    expect(report.drifted).toEqual(["example.com"]);
    expect(mutations).toEqual([]); // never "fixes" a zone by itself
    const write = statusWrites(writes)[0];
    expect(write?.binds).toContain(MailStatus.Conflict);
    expect(write?.binds).toContain(ConflictType.Drift);
    expect(JSON.stringify(write?.binds)).toContain("someone-else");
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
    vi.stubGlobal("fetch", vi.fn(async () => publicMxAnswer()));
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
    expect(writes).toEqual([]);
  });
});

describe("watchdog public-DNS probe (the lapsed-registration blind spot)", () => {
  const dnsJson = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/dns-json" } }));

  it("flags a domain the public internet cannot resolve while Cloudflare looks healthy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => dnsJson({ Status: 3 })));
    const { client } = stubClient({});
    const { db, writes } = stubDb();

    const report = await watchDomains(db, client, [domain()], WORKER);

    expect(report.drifted).toContain("example.com");
    expect(writes.some((w) => w.binds.join(" ").includes("watchdog:dns_unresolvable"))).toBe(true);
  });

  it("keeps the domain ok when a public resolver sees its MX", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => dnsJson({ Status: 0, Answer: [{ type: 15 }] })));
    const { client } = stubClient({});
    const { db } = stubDb();

    const report = await watchDomains(db, client, [domain()], WORKER);

    expect(report.ok).toContain("example.com");
    expect(report.drifted).toEqual([]);
  });

  it("never downgrades a domain when the probe itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("probe unreachable"); }));
    const { client } = stubClient({});
    const { db } = stubDb();

    const report = await watchDomains(db, client, [domain()], WORKER);

    expect(report.ok).toContain("example.com");
    expect(report.drifted).toEqual([]);
  });

  it("does not probe a domain MailVault does not believe is receiving", async () => {
    const fetchSpy = vi.fn(async () => dnsJson({ Status: 3 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { client } = stubClient({});
    const { db } = stubDb();

    await watchDomains(db, client, [domain({ mailStatus: MailStatus.Discovered })], WORKER);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
