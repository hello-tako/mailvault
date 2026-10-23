import { describe, expect, it } from "vitest";
import {
  AuthPolicy,
  CatchAllStatus,
  ConflictType,
  MailStatus,
  PreflightClassification,
  RoutingStatus,
  SendingStatus,
} from "@mailvault/shared";
import { CloudflareApiError, type CloudflareClient } from "../../src/cf/api-client";
import type { DomainRow } from "../../src/db/rows";
import { preflightMany, provisionDomain } from "../../src/provisioning/provisioner";

const row: DomainRow = {
  id: "d1",
  cloudflare_zone_id: "z1",
  cloudflare_account_id: null,
  name: "example.com",
  zone_status: "active",
  zone_type: "full",
  mail_status: MailStatus.Discovered,
  routing_status: RoutingStatus.Unknown,
  catch_all_status: CatchAllStatus.Unknown,
  conflict_type: ConflictType.None,
  conflict_details_json: null,
  auth_policy: AuthPolicy.Warn,
  sending_status: SendingStatus.Unknown,
  sending_via: null,
  sending_tag: null,
  sending_checked_at: null,
  last_checked_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function stubDb(found = true) {
  const writes: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const isSelect = /^\s*SELECT/i.test(sql);
      let binds: unknown[] = [];
      const api: Record<string, unknown> = {
        bind: (...args: unknown[]) => {
          binds = args;
          return api;
        },
        first: async () => (isSelect ? (found ? row : null) : null),
        all: async () => [],
        run: async () => {
          writes.push({ sql: sql.replace(/\s+/g, " ").trim(), binds });
          return { success: true, meta: {} };
        },
      };
      return api;
    },
    batch: async () => [],
  };
  return { db: db as unknown as D1Database, writes };
}

function stubClient(
  overrides: Partial<
    Record<"listDnsRecords" | "getEmailRoutingStatus" | "enableEmailRouting" | "getCatchAll", () => Promise<unknown>>
  > = {},
) {
  const mutations: string[] = [];
  const deletedDnsIds = new Set<string>();
  const client = {
    hasToken: true,
    listAllZones: async () => [],
    listDnsRecords: async (_zoneId: string, type?: string) => {
      const records = overrides.listDnsRecords ? ((await overrides.listDnsRecords()) as never) : [];
      return records.filter((record: { id?: string; type?: string }) =>
        (!record.id || !deletedDnsIds.has(record.id)) && (!type || (record.type ? record.type === type : type === "MX")),
      );
    },
    getEmailRoutingStatus: async () =>
      overrides.getEmailRoutingStatus ? ((await overrides.getEmailRoutingStatus()) as never) : {},
    getEmailRoutingDns: async () => [],
    enableEmailRouting: async () => {
      if (overrides.enableEmailRouting) {
        await overrides.enableEmailRouting();
        return;
      }
      mutations.push("enableEmailRouting");
    },
    getCatchAll: async () => (overrides.getCatchAll ? ((await overrides.getCatchAll()) as never) : null),
    setCatchAllWorker: async () => {
      mutations.push("setCatchAllWorker");
    },
    deleteDnsRecord: async (_zoneId: string, id: string) => {
      mutations.push(`deleteDnsRecord:${id}`);
      deletedDnsIds.add(id);
    },
  } as unknown as CloudflareClient;
  return { client, mutations };
}

const deniedRead = () => {
  throw new CloudflareApiError("permission", "Cloudflare API error: Authentication error", 403, [10000]);
};

describe("provisionDomain allow-list gate (section 7/9)", () => {
  it("refuses to mutate when the MX read is denied by Cloudflare", async () => {
    const { client, mutations } = stubClient({ listDnsRecords: deniedRead });
    const { db, writes } = stubDb();

    const out = await provisionDomain(db, client, "z1", "mail-vault", {});

    expect(mutations).toEqual([]);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("API_PERMISSION_ERROR");
    // It must still have recorded the local outcome for the audit trail.
    expect(writes.length).toBeGreaterThan(0);
  });

  it("refuses to mutate over a third-party MX even when takeover is requested", async () => {
    const { client, mutations } = stubClient({
      listDnsRecords: async () => [{ content: "aspmx.l.google.com", priority: 1 }],
    });
    const { db } = stubDb();

    const out = await provisionDomain(db, client, "z1", "mail-vault", { allowCatchAllTakeover: true });

    expect(mutations).toEqual([]);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(MailStatus.Conflict);
  });

  it("proceeds when only the routing settings flag is unreadable and MX is clean", async () => {
    const { client, mutations } = stubClient({ getEmailRoutingStatus: deniedRead });
    const { db } = stubDb();

    const out = await provisionDomain(db, client, "z1", "mail-vault", {});

    // The routing flag is not a safety signal; foreign MX and foreign catch-all are.
    expect(mutations).toContain("enableEmailRouting");
    expect(out.ok).toBe(false); // verification still refuses to claim READY blindly
  });

  it("does not re-enable routing when Cloudflare MX already exist", async () => {
    const { client, mutations } = stubClient({
      listDnsRecords: async () => [{ content: "route1.mx.cloudflare.net", priority: 36 }],
    });
    const { db } = stubDb();

    const out = await provisionDomain(db, client, "z1", "mail-vault", {});

    expect(mutations).not.toContain("enableEmailRouting");
    expect(mutations).toContain("setCatchAllWorker");
    expect(out.steps.map((s) => s.step)).toContain("email_routing_dns");
  });

  it("points at the token's zone scope when routing cannot be enabled", async () => {
    const { client } = stubClient({
      enableEmailRouting: async () => {
        throw new CloudflareApiError(
          "permission",
          "Cloudflare API error: Authentication error",
          403,
          [10000],
          "/zones/z1/email/routing/enable",
        );
      },
    });
    const { db } = stubDb();

    const out = await provisionDomain(db, client, "z1", "mail-vault", {});

    expect(out.ok).toBe(false);
    expect(out.error).toContain("Email Routing is not enabled for this domain");
    expect(out.error).toContain("Email Routing Rules → Edit");
    expect(out.error).toContain("Zone Resources");
    expect(out.error).toContain("No MX record was touched");
    expect(out.error).not.toContain("Authentication error");
  });

  it("proceeds for a clean zone", async () => {
    const { client, mutations } = stubClient();
    const { db } = stubDb();

    const out = await provisionDomain(db, client, "z1", "mail-vault", {});

    expect(mutations).toContain("enableEmailRouting");
    expect(mutations).toContain("setCatchAllWorker");
    // Verification re-reads routing state; the stub reports it as not-ready, so the
    // domain must NOT be marked READY off a single successful write.
    expect(out.status).toBe(MailStatus.Failed);
    expect(out.ok).toBe(false);
  });

  it("refuses a zone MailVault never imported, which is what bounds an account-wide token", async () => {
    const { client, mutations } = stubClient();
    const { db, writes } = stubDb(false);

    const out = await provisionDomain(db, client, "z9", "mail-vault", { allowCatchAllTakeover: true });

    expect(out.ok).toBe(false);
    expect(out.error).toContain("Domain not synced yet");
    expect(mutations).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("preflightMany remembers its verdict locally, never in Cloudflare", () => {
  it("stores a foreign-MX conflict so the Domains table still shows it after a reload", async () => {
    const { client, mutations } = stubClient({
      listDnsRecords: async () => [{ content: "aspmx.l.google.com", priority: 1 }],
    });
    const { db, writes } = stubDb();

    const [res] = await preflightMany(db, client, ["z1"], "mail-vault");
    const upd = writes.find((w) => /UPDATE domains/.test(w.sql));

    expect(res?.classification).toBe(PreflightClassification.MxConflict);
    expect(mutations).toEqual([]); // Cloudflare untouched
    expect(upd?.sql).toContain("mail_status");
    expect(upd?.binds).toContain(MailStatus.Conflict);
    expect(upd?.binds).toContain(ConflictType.Mx);
  });

  it("only stamps last_checked_at when Cloudflare refused the read", async () => {
    const { client } = stubClient({ listDnsRecords: deniedRead });
    const { db, writes } = stubDb();

    const [res] = await preflightMany(db, client, ["z1"], "mail-vault");
    const upd = writes.find((w) => /UPDATE domains/.test(w.sql));

    expect(res?.classification).toBe(PreflightClassification.ApiPermissionError);
    expect(upd?.sql).not.toContain("mail_status");
    expect(upd?.sql).toContain("last_checked_at");
  });
});

/*
 * MX takeover is the one provisioning action that stops mail arriving somewhere else, so
 * the tests are about who may pull that trigger and what is left behind to undo it.
 */
describe("owner-confirmed MX takeover", () => {
  const zoneDns = async () => [
    { id: "mx-google", type: "MX", name: "example.com", content: "aspmx.l.google.com", priority: 1 },
    { id: "txt-old-spf", type: "TXT", name: "example.com", content: "v=spf1 include:_spf.google.com ~all" },
    { id: "txt-cf-spf", type: "TXT", name: "example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
    { id: "txt-dmarc", type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=reject" },
    { id: "txt-key", type: "TXT", name: "google._domainkey.example.com", content: "v=DKIM1; k=rsa; p=AAA" },
  ];
  const deletes = (mutations: string[]) => mutations.filter((m) => m.startsWith("deleteDnsRecord"));

  it("never deletes Cloudflare's own routing MX while clearing the rest", async () => {
    const { client, mutations } = stubClient({
      listDnsRecords: async () => [
        { id: "mx-google", type: "MX", name: "example.com", content: "aspmx.l.google.com", priority: 1 },
        { id: "mx-cf", type: "MX", name: "example.com", content: "route1.mx.cloudflare.net", priority: 36 },
      ],
    });
    const { db } = stubDb();

    await provisionDomain(db, client, "z1", "mail-vault", { allowMxTakeover: true, authorizeTakeover: async () => {} });

    expect(deletes(mutations)).toEqual(["deleteDnsRecord:mx-google"]);
  });

  it("removes the foreign MX and nothing else, then enables routing", async () => {
    const { client, mutations } = stubClient({ listDnsRecords: zoneDns });
    const { db, writes } = stubDb();

    const out = await provisionDomain(db, client, "z1", "mail-vault", { allowMxTakeover: true, authorizeTakeover: async () => {} });

    expect(deletes(mutations)).toEqual(["deleteDnsRecord:mx-google"]);
    expect(mutations).toContain("enableEmailRouting");
    // Measured on a real takeover: enabling routing does not add a second SPF, so deleting
    // the provider's SPF would break the owner's outbound mail for no gain. DKIM/DMARC too.
    expect(mutations).not.toContain("deleteDnsRecord:txt-old-spf");
    expect(mutations).not.toContain("deleteDnsRecord:txt-cf-spf");
    expect(mutations).not.toContain("deleteDnsRecord:txt-dmarc");
    expect(mutations).not.toContain("deleteDnsRecord:txt-key");

    const audit = writes.filter((w) => /INSERT INTO provisioning_events/.test(w.sql)).map((w) => JSON.stringify(w.binds));
    expect(audit.some((a) => a.includes("mx_takeover") && a.includes("aspmx.l.google.com"))).toBe(true);
    expect(out.steps.map((s) => s.step)).toContain("mx_takeover");
  });

  it("deletes nothing without the confirmation", async () => {
    const { client, mutations } = stubClient({ listDnsRecords: zoneDns });
    const { db } = stubDb();

    const out = await provisionDomain(db, client, "z1", "mail-vault", {});

    expect(deletes(mutations)).toEqual([]);
    expect(out.status).toBe(MailStatus.Conflict);
  });

  it("a catch-all confirmation does not buy an MX deletion as well", async () => {
    const { client, mutations } = stubClient({ listDnsRecords: zoneDns });
    const { db } = stubDb();

    await provisionDomain(db, client, "z1", "mail-vault", { allowCatchAllTakeover: true });

    expect(deletes(mutations)).toEqual([]);
  });

  it("refuses a domain the owner excluded, whatever the flags say", async () => {
    const { client, mutations } = stubClient({ listDnsRecords: zoneDns });
    const { db } = stubDb();

    const out = await provisionDomain(db, client, "z1", "mail-vault", {
      allowMxTakeover: true,
      allowCatchAllTakeover: true,
      denyDomains: ["EXAMPLE.COM"],
    });

    expect(mutations).toEqual([]);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("excluded from MailVault management");
  });
});

describe("live takeover checks", () => {
  it("does not delete an MX conflict that disappeared after the first preflight", async () => {
    let reads = 0;
    const { client, mutations } = stubClient({
      listDnsRecords: async () => {
        reads += 1;
        return reads === 1
          ? [{ id: "old-mx", type: "MX", name: "example.com", content: "aspmx.l.google.com", priority: 1 }]
          : [{ id: "cf-mx", type: "MX", name: "example.com", content: "route1.mx.cloudflare.net", priority: 10 }];
      },
    });
    const { db } = stubDb();
    let authorized = 0;

    const result = await provisionDomain(db, client, "z1", "mail-vault", {
      authorizeTakeover: async () => void (authorized += 1),
    });

    expect(result.ok).toBe(false);
    expect(mutations.filter((mutation) => mutation.startsWith("deleteDnsRecord"))).toEqual([]);
    expect(authorized).toBe(0);
  });

  it("does not replace a catch-all conflict that disappeared before the write", async () => {
    let reads = 0;
    const { client, mutations } = stubClient({
      getCatchAll: async () => {
        reads += 1;
        return reads === 1
          ? { enabled: true, actions: [{ type: "forward", value: ["elsewhere@example.net"] }] }
          : null;
      },
    });
    const { db } = stubDb();
    let authorized = 0;

    const result = await provisionDomain(db, client, "z1", "mail-vault", {
      authorizeTakeover: async () => void (authorized += 1),
    });

    expect(result.ok).toBe(false);
    expect(mutations).toContain("setCatchAllWorker");
    expect(authorized).toBe(0);
  });
});
