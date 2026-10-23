import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Env } from "../../src/env";
import { commitIngest, ingestEmail, stageEmail, type IngestJob } from "../../src/mail/ingest";
import worker from "../../src/index";
import { getTestBindings, type TestBindings } from "./_mf";
import {
  controlledTxtResolver,
  createDkimKey,
  signMessage,
  type DkimKey,
} from "../compat/dkim-fixtures";

let bindings: TestBindings;
let env: Env;
let db: D1Database;
let bucket: R2Bucket;

beforeAll(async () => {
  bindings = await getTestBindings();
  env = bindings.env;
  db = bindings.db;
  bucket = bindings.bucket;
});

afterAll(async () => {
  await bindings?.dispose();
});

beforeEach(async () => {
  await db.prepare("DELETE FROM attachments").run();
  await db.prepare("DELETE FROM messages").run();
  await db.prepare("DELETE FROM aliases").run();
  await db.prepare("DELETE FROM domains").run();
});

async function seedAlias(address: string, policy: "WARN" | "REJECT" = "WARN"): Promise<void> {
  const domainId = crypto.randomUUID();
  const [localPart, domain] = address.split("@");
  await db
    .prepare(
      `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status, auth_policy)
       VALUES (?1, ?2, ?3, 'active', 'full', 'READY', ?4)`,
    )
    .bind(domainId, `zone-${domain}-${domainId.slice(0, 6)}`, domain, policy)
    .run();
  await db
    .prepare(
      "INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, ?3, ?4, 'ACTIVE')",
    )
    .bind(crypto.randomUUID(), domainId, localPart, address)
    .run();
}

function message(
  to: string,
  authResult: string,
  authHeader = "Authentication-Results",
  headerFrom = "Security <security@example.com>",
) {
  const raw = new TextEncoder().encode(
    [
      `From: ${headerFrom}`,
      `To: ${to}`,
      "Subject: Account notification",
      "Message-ID: <sender-auth@example.com>",
      "Date: Fri, 19 Sep 2026 12:00:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      `${authHeader}: ${authResult}`,
      "",
      "Your verification code is 123456.",
      "",
    ].join("\r\n"),
  );
  return envelope(to, raw);
}

function envelope(to: string, raw: Uint8Array) {
  return {
    from: "bounce@attacker.invalid",
    to,
    headers: new Headers(),
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    rawSize: raw.byteLength,
    setReject() {},
  };
}

const dkimKey = createDkimKey("rsa-sha256", "sel", "example.com");
const unpublishedKeys = controlledTxtResolver([]);
const queueContext = {
  waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

/** A message From `from`, signed by `key`. `extraHeaders` sit below the signed fields. */
function signedMessage(
  to: string,
  key: DkimKey,
  from = "security@example.com",
  extraHeaders: string[] = [],
): Uint8Array {
  return new TextEncoder().encode(
    signMessage(key, {
      headers: [
        `From: Security <${from}>`,
        `To: ${to}`,
        "Subject: Account notification",
        `Message-ID: <${crypto.randomUUID()}@example.com>`,
        "Date: Fri, 19 Sep 2026 12:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        ...extraHeaders,
      ],
      body: "Your verification code is 123456.\r\n",
    }),
  );
}

/** Hands a staged job to the queue consumer as delivery attempt `attempts`. */
async function deliverJob(job: IngestJob, attempts: number): Promise<string[]> {
  const decisions: string[] = [];
  await worker.queue(
    {
      queue: "mail-ingest",
      messages: [
        {
          id: "sender-auth-retry",
          timestamp: new Date(),
          attempts,
          body: job,
          ack: () => void decisions.push("ack"),
          retry: () => void decisions.push("retry"),
        },
      ],
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as never,
    env,
    queueContext,
  );
  return decisions;
}

function storedRow(messageId: string) {
  return db
    .prepare("SELECT auth_verdict, auth_json, ingest_status FROM messages WHERE id = ?1")
    .bind(messageId)
    .first<{ auth_verdict: string; auth_json: string; ingest_status: string | null }>();
}

describe("sender authentication provenance through Miniflare ingest", () => {
  it("revokes historical inbound auth verdicts and evidence without changing outbound mail", async () => {
    await seedAlias("history@notify.example");
    const domain = await db
      .prepare("SELECT id FROM domains WHERE name = 'notify.example'")
      .first<{ id: string }>();
    expect(domain).not.toBeNull();

    await db.batch([
      db
        .prepare(
          `INSERT INTO messages (id, domain_id, dedupe_key, received_at, raw_r2_key, direction, auth_verdict, auth_json)
           VALUES ('old-trusted', ?1, 'old-trusted', '2026-01-01T00:00:00.000Z', 'old/trusted.eml', 'IN', 'TRUSTED', '{"source":"message-header"}')`,
        )
        .bind(domain!.id),
      db
        .prepare(
          `INSERT INTO messages (id, domain_id, dedupe_key, received_at, raw_r2_key, direction, auth_verdict, auth_json)
           VALUES ('old-spoofed', ?1, 'old-spoofed', '2026-01-01T00:00:00.000Z', 'old/spoofed.eml', 'IN', 'SPOOFED', '{"source":"message-header"}')`,
        )
        .bind(domain!.id),
      db
        .prepare(
          `INSERT INTO messages (id, domain_id, dedupe_key, received_at, raw_r2_key, direction, auth_verdict, auth_json)
           VALUES ('sent-trusted', ?1, 'sent-trusted', '2026-01-01T00:00:00.000Z', 'old/sent.eml', 'OUT', 'TRUSTED', '{"source":"outbound"}')`,
        )
        .bind(domain!.id),
    ]);

    const migration = readFileSync(
      new URL("../../migrations/0016_revoke_legacy_sender_auth.sql", import.meta.url),
      "utf8",
    );
    const sql = migration
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    await db.prepare(sql).run();

    const rows = await db
      .prepare("SELECT id, direction, auth_verdict, auth_json FROM messages ORDER BY id")
      .all<{ id: string; direction: string; auth_verdict: string; auth_json: string | null }>();
    expect(rows.results).toEqual([
      { id: "old-spoofed", direction: "IN", auth_verdict: "UNVERIFIED", auth_json: null },
      { id: "old-trusted", direction: "IN", auth_verdict: "UNVERIFIED", auth_json: null },
      {
        id: "sent-trusted",
        direction: "OUT",
        auth_verdict: "TRUSTED",
        auth_json: '{"source":"outbound"}',
      },
    ]);
  });

  it("stores a forged aligned pass as UNVERIFIED", async () => {
    const to = "aligned@notify.example";
    await seedAlias(to);

    const result = await ingestEmail(
      message(
        to,
        "attacker.invalid; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      ),
      env,
      db,
      bucket,
    );

    expect(result).toMatchObject({ status: "stored", verdict: "UNVERIFIED" });
    const row = await db
      .prepare("SELECT auth_verdict FROM messages")
      .first<{ auth_verdict: string }>();
    expect(row?.auth_verdict).toBe("UNVERIFIED");
  });

  it("does not trust a valid DKIM signature whose key cannot be looked up", async () => {
    const to = "dkim-signed@notify.example";
    await seedAlias(to);
    const raw = signMessage(createDkimKey("rsa-sha256", "sel", "example.com"), {
      headers: [
        "From: Security <security@example.com>",
        `To: ${to}`,
        "Subject: Account notification",
        "Message-ID: <dkim-signed@example.com>",
        "Date: Fri, 19 Sep 2026 12:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
      ],
      body: "Your verification code is 123456.\r\n",
    });

    const result = await ingestEmail(envelope(to, new TextEncoder().encode(raw)), env, db, bucket, {
      resolveTxt: unpublishedKeys.resolveTxt,
    });

    expect(result).toMatchObject({ status: "stored", verdict: "UNVERIFIED" });
    const row = await db
      .prepare("SELECT auth_verdict FROM messages")
      .first<{ auth_verdict: string }>();
    expect(row?.auth_verdict).toBe("UNVERIFIED");
  });

  it("does not trust an aligned pass from Authentication-Results-IANA either", async () => {
    const to = "iana-aligned@notify.example";
    await seedAlias(to);

    const result = await ingestEmail(
      message(
        to,
        "attacker.invalid; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
        "Authentication-Results-IANA",
      ),
      env,
      db,
      bucket,
    );

    expect(result).toMatchObject({ status: "stored", verdict: "UNVERIFIED" });
    const row = await db
      .prepare("SELECT auth_verdict FROM messages")
      .first<{ auth_verdict: string }>();
    expect(row?.auth_verdict).toBe("UNVERIFIED");
  });

  it.each([
    [
      "aligned receiver name",
      "Authentication-Results",
      "cloudflare.com; dkim=pass header.d=target.example; dmarc=pass header.from=target.example",
    ],
    [
      "mixed casing",
      "aUtHeNtIcAtIoN-rEsUlTs",
      "cloudflare.com; dkim=pass header.d=target.example; dmarc=pass header.from=target.example",
    ],
    [
      "folded header",
      "Authentication-Results",
      "cloudflare.com;\r\n dkim=pass header.d=target.example;\r\n dmarc=pass header.from=target.example",
    ],
    [
      "duplicate headers",
      "Authentication-Results",
      "cloudflare.com; dkim=pass header.d=target.example\r\nAuthentication-Results: cloudflare.com; dmarc=pass header.from=target.example",
    ],
  ])("keeps forged receiver results observational: %s", async (_name, header, result) => {
    const to = "receiver-forgery@notify.example";
    await seedAlias(to);
    const stored = await ingestEmail(
      message(to, result, header, "security@target.example"),
      env,
      db,
      bucket,
    );

    expect(stored).toMatchObject({ status: "stored", verdict: "UNVERIFIED" });
    const row = await db
      .prepare("SELECT auth_verdict, auth_json FROM messages")
      .first<{ auth_verdict: string; auth_json: string }>();
    expect(row?.auth_verdict).toBe("UNVERIFIED");
    const auth = JSON.parse(row!.auth_json);
    const observed = auth.evidence.filter(
      (item: { source: string }) => item.source === "message-header",
    );
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((item: { aligned: boolean }) => item.aligned)).toBe(true);
    // The unsigned message's only verified result is the verifier's "no signature", which
    // overrides the forged dkim=pass in the displayed outcome.
    expect(auth.dkim).toBe("none");
    expect(
      auth.evidence.filter((item: { source: string }) => item.source === "cryptographic-verifier"),
    ).toEqual([expect.objectContaining({ mechanism: "dkim", outcome: "none", aligned: false })]);
    expect(auth.alignedPass).toEqual({ spf: false, dkim: false, dmarc: false });
  });

  it("preserves UNVERIFIED across partial commit, queue retry and replay", async () => {
    const to = "receiver-retry@notify.example";
    await seedAlias(to);
    const staged = await stageEmail(
      message(
        to,
        "cloudflare.com; dkim=pass header.d=target.example; dmarc=pass header.from=target.example",
        "Authentication-Results",
        "security@target.example",
      ),
      env,
      db,
      bucket,
    );
    expect(staged.status).toBe("staged");
    if (staged.status !== "staged") throw new Error("expected_staged_message");
    const job = staged.job;
    const deliver = (attempts: number) => deliverJob(job, attempts);
    const storedAuth = () =>
      db
        .prepare("SELECT auth_verdict, auth_json, ingest_status FROM messages WHERE id = ?1")
        .bind(job.messageId)
        .first<{ auth_verdict: string; auth_json: string; ingest_status: string | null }>();

    await db
      .prepare(
        `CREATE TRIGGER sender_auth_fail_core BEFORE UPDATE OF ingest_status ON messages
       BEGIN SELECT RAISE(FAIL, 'sender_auth_partial_commit'); END`,
      )
      .run();
    let partial;
    try {
      expect(await deliver(1)).toEqual(["retry"]);
      partial = await storedAuth();
      expect(partial).toMatchObject({ auth_verdict: "UNVERIFIED", ingest_status: null });
      expect(await bucket.head(job.rawKey)).not.toBeNull();
      expect(await bucket.head(job.parsedKey)).not.toBeNull();
    } finally {
      await db.prepare("DROP TRIGGER sender_auth_fail_core").run();
    }

    expect(await deliver(2)).toEqual(["ack"]);
    const completed = await storedAuth();
    expect(completed).toMatchObject({
      auth_verdict: "UNVERIFIED",
      auth_json: partial!.auth_json,
      ingest_status: "COMMITTED",
    });
    expect(await deliver(3)).toEqual(["ack"]);
    expect(await storedAuth()).toEqual(completed);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM messages").first()).toEqual({
      count: 1,
    });
  });

  it("does not reject based on a forged DMARC failure, even under REJECT policy", async () => {
    const to = "forged-fail@notify.example";
    await seedAlias(to, "REJECT");

    const result = await ingestEmail(
      message(to, "attacker.invalid; dmarc=fail header.from=example.com"),
      env,
      db,
      bucket,
    );

    expect(result).toMatchObject({ status: "stored", verdict: "UNVERIFIED" });
    const row = await db
      .prepare("SELECT auth_verdict FROM messages")
      .first<{ auth_verdict: string }>();
    expect(row?.auth_verdict).toBe("UNVERIFIED");
  });

  it("stores a valid aligned DKIM signature as TRUSTED, verified once during staging", async () => {
    const to = "dkim-trusted@notify.example";
    await seedAlias(to);
    const dns = controlledTxtResolver([dkimKey]);

    const result = await ingestEmail(envelope(to, signedMessage(to, dkimKey)), env, db, bucket, {
      resolveTxt: dns.resolveTxt,
    });

    expect(result).toMatchObject({ status: "stored", verdict: "TRUSTED" });
    expect(dns.queries).toEqual(["sel._domainkey.example.com"]);
    const row = await db
      .prepare("SELECT auth_verdict, auth_json FROM messages")
      .first<{ auth_verdict: string; auth_json: string }>();
    expect(row?.auth_verdict).toBe("TRUSTED");
    const auth = JSON.parse(row!.auth_json);
    expect(auth.alignedPass.dkim).toBe(true);
    expect(auth.evidence).toContainEqual(
      expect.objectContaining({
        mechanism: "dkim",
        outcome: "pass",
        domain: "example.com",
        aligned: true,
        source: "cryptographic-verifier",
      }),
    );
  });

  it("keeps the staged verdict across commit, queue retry and replay without another lookup", async () => {
    const to = "dkim-replay@notify.example";
    await seedAlias(to);
    const dns = controlledTxtResolver([dkimKey]);
    const staged = await stageEmail(envelope(to, signedMessage(to, dkimKey)), env, db, bucket, {
      resolveTxt: dns.resolveTxt,
    });
    if (staged.status !== "staged") throw new Error("expected_staged_message");
    const lookups = dns.queries.length;
    // The key disappears after staging; no later step may need it.
    delete dns.answers["sel._domainkey.example.com"];

    expect(await deliverJob(staged.job, 1)).toEqual(["ack"]);
    const committed = await storedRow(staged.job.messageId);
    expect(committed).toMatchObject({ auth_verdict: "TRUSTED", ingest_status: "COMMITTED" });
    expect(await deliverJob(staged.job, 2)).toEqual(["ack"]);
    expect(await deliverJob(staged.job, 3)).toEqual(["ack"]);
    expect(await storedRow(staged.job.messageId)).toEqual(committed);
    expect(dns.queries).toHaveLength(lookups);
  });

  it("keeps a staged TRUSTED verdict through a partial commit and queue retry", async () => {
    const to = "dkim-partial@notify.example";
    await seedAlias(to);
    const dns = controlledTxtResolver([dkimKey]);
    const staged = await stageEmail(envelope(to, signedMessage(to, dkimKey)), env, db, bucket, {
      resolveTxt: dns.resolveTxt,
    });
    if (staged.status !== "staged") throw new Error("expected_staged_message");
    const lookups = dns.queries.length;

    await db
      .prepare(
        `CREATE TRIGGER sender_auth_fail_trusted BEFORE UPDATE OF ingest_status ON messages
       BEGIN SELECT RAISE(FAIL, 'sender_auth_partial_commit'); END`,
      )
      .run();
    let partial;
    try {
      expect(await deliverJob(staged.job, 1)).toEqual(["retry"]);
      partial = await storedRow(staged.job.messageId);
      expect(partial).toMatchObject({ auth_verdict: "TRUSTED", ingest_status: null });
    } finally {
      await db.prepare("DROP TRIGGER sender_auth_fail_trusted").run();
    }

    expect(await deliverJob(staged.job, 2)).toEqual(["ack"]);
    expect(await storedRow(staged.job.messageId)).toMatchObject({
      auth_verdict: "TRUSTED",
      auth_json: partial!.auth_json,
      ingest_status: "COMMITTED",
    });
    expect(dns.queries).toHaveLength(lookups);
  });

  it("stores a signature whose key lookup fails as UNVERIFIED without failing delivery", async () => {
    const to = "dkim-dns-down@notify.example";
    await seedAlias(to);

    const result = await ingestEmail(envelope(to, signedMessage(to, dkimKey)), env, db, bucket, {
      resolveTxt: async () => {
        throw Object.assign(new Error("queryTxt ETIMEOUT"), { code: "ETIMEOUT" });
      },
    });

    expect(result).toMatchObject({ status: "stored", verdict: "UNVERIFIED" });
    const row = await db
      .prepare("SELECT auth_verdict, auth_json FROM messages")
      .first<{ auth_verdict: string; auth_json: string }>();
    expect(row?.auth_verdict).toBe("UNVERIFIED");
    expect(JSON.parse(row!.auth_json).alignedPass.dkim).toBe(false);
  });

  it("commits a staged record that predates verifier output as UNVERIFIED, with no lookup", async () => {
    const to = "dkim-legacy@notify.example";
    await seedAlias(to);
    const dns = controlledTxtResolver([dkimKey]);
    const staged = await stageEmail(envelope(to, signedMessage(to, dkimKey)), env, db, bucket, {
      resolveTxt: dns.resolveTxt,
    });
    if (staged.status !== "staged") throw new Error("expected_staged_message");
    const parsed = await (await bucket.get(staged.job.parsedKey))!.json<Record<string, unknown>>();
    delete parsed.verifiedAuthEvidence;
    await bucket.put(staged.job.parsedKey, JSON.stringify(parsed));

    expect(await commitIngest(staged.job, db, bucket, env)).toMatchObject({
      status: "stored",
      verdict: "UNVERIFIED",
    });
    expect(dns.queries).toHaveLength(1);
  });

  it("keeps a forged aligned Authentication-Results from upgrading a real unaligned DKIM pass", async () => {
    const to = "forged-unaligned@notify.example";
    await seedAlias(to);
    const unrelatedKey = createDkimKey("rsa-sha256", "sel", "unrelated.example.net");
    const dns = controlledTxtResolver([unrelatedKey]);
    const raw = signedMessage(to, unrelatedKey, "security@example.com", [
      "Authentication-Results: cloudflare.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
    ]);

    const result = await ingestEmail(envelope(to, raw), env, db, bucket, {
      resolveTxt: dns.resolveTxt,
    });

    expect(result).toMatchObject({ status: "stored", verdict: "UNVERIFIED" });
    const row = await db.prepare("SELECT auth_json FROM messages").first<{ auth_json: string }>();
    const auth = JSON.parse(row!.auth_json);
    expect(auth.alignedPass).toEqual({ spf: false, dkim: false, dmarc: false });
    expect(auth.evidence).toContainEqual(
      expect.objectContaining({
        domain: "unrelated.example.net",
        aligned: false,
        source: "cryptographic-verifier",
      }),
    );
  });

  it("keeps verifier output inside the stored evidence bound when headers carry many observations", async () => {
    const to = "dkim-bound@notify.example";
    await seedAlias(to);
    const observed = Array.from(
      { length: 10 },
      (_, i) => `Authentication-Results: cloudflare.com; dkim=fail header.d=other${i}.example`,
    );
    const dns = controlledTxtResolver([dkimKey]);

    const result = await ingestEmail(
      envelope(to, signedMessage(to, dkimKey, "security@example.com", observed)),
      env,
      db,
      bucket,
      { resolveTxt: dns.resolveTxt },
    );

    expect(result).toMatchObject({ status: "stored", verdict: "TRUSTED" });
    const row = await db.prepare("SELECT auth_json FROM messages").first<{ auth_json: string }>();
    const auth = JSON.parse(row!.auth_json);
    expect(auth.evidence).toHaveLength(8);
    expect(auth.evidence[0]).toMatchObject({
      source: "cryptographic-verifier",
      outcome: "pass",
      aligned: true,
    });
  });
});
