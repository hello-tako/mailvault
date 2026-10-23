import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { commitIngest, ingestEmail, stageEmail, type IngestJob } from "../../src/mail/ingest";
import { getObject } from "../../src/storage/r2";
import { deleteMessage, listMessages } from "../../src/db/messages";
import { addressReuseReport } from "../../src/db/report";
import { getTestBindings, type TestBindings } from "./_mf";

let bindings: TestBindings;
let TEST_ENV: Env;
let DB: D1Database;
let BUCKET: R2Bucket;

beforeAll(async () => {
  bindings = await getTestBindings();
  TEST_ENV = bindings.env;
  DB = bindings.db;
  BUCKET = bindings.bucket;
});

afterAll(async () => {
  await bindings?.dispose();
});

function emailRaw(opts: {
  subject: string;
  messageId: string;
  body: string;
  to: string;
  from?: string;
  authResults?: string[];
}): Uint8Array {
  const mime = [
    `From: ${opts.from ?? "GitHub <noreply@github.com>"}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Message-ID: <${opts.messageId}@github.com>`,
    "Date: Fri, 19 Sep 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    ...(opts.authResults ?? []).map((v) => `Authentication-Results: ${v}`),
    "",
    opts.body,
    "",
  ].join("\r\n");
  return new TextEncoder().encode(mime);
}

function makeMessage(to: string, raw: Uint8Array, from = "noreply@github.com") {
  const rejects: string[] = [];
  const message = {
    from,
    to,
    headers: new Headers(),
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    rawSize: raw.byteLength,
    setReject(reason: string) {
      rejects.push(reason);
    },
  };
  return { message, rejects };
}

async function seedAlias(address: string, status: "ACTIVE" | "DISABLED" = "ACTIVE") {
  const domainId = crypto.randomUUID();
  const [local, domain] = address.split("@");
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status)
     VALUES (?1, ?2, ?3, 'active', 'full', 'READY')`,
  )
    .bind(domainId, `zone-${domain}-${domainId.slice(0, 6)}`, domain)
    .run();
  await DB.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(crypto.randomUUID(), domainId, local, address, status)
    .run();
  return domainId;
}

async function countMessages(): Promise<number> {
  const r = await DB.prepare(`SELECT COUNT(*) AS c FROM messages`).first<{ c: number }>();
  return Number(r?.c ?? 0);
}

beforeEach(async () => {
  await DB.prepare(`DELETE FROM attachments`).run();
  await DB.prepare(`DELETE FROM messages`).run();
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM provisioning_events`).run();
  await DB.prepare(`DELETE FROM domains`).run();
});

describe("inbound email ingestion", () => {
  it("stores mail for an ACTIVE alias and extracts the OTP", async () => {
    await seedAlias("github-x7k2@notify.example");
    const { message } = makeMessage(
      "github-x7k2@notify.example",
      emailRaw({
        subject: "Your code",
        body: "Your GitHub verification code is 593821.",
        messageId: "m1",
        to: "github-x7k2@notify.example",
      }),
    );

    const result = await ingestEmail(message, TEST_ENV, DB, BUCKET);
    expect(result.status).toBe("stored");
    expect(await countMessages()).toBe(1);

    const row = await DB.prepare(`SELECT raw_r2_key, extracted_codes_json FROM messages`).first<{
      raw_r2_key: string;
      extracted_codes_json: string;
    }>();
    expect(row?.extracted_codes_json).toContain("593821");
    const rawObj = await BUCKET.get(row!.raw_r2_key);
    expect(rawObj).toBeTruthy();
    const text = await new Response(rawObj!.body as ReadableStream).text();
    expect(text).toContain("593821");
  });

  it("rejects unknown recipients and never auto-creates an alias", async () => {
    const { message, rejects } = makeMessage(
      "who-is-this@notify.example",
      emailRaw({ subject: "hi", body: "hello", messageId: "m2", to: "who-is-this@notify.example" }),
    );
    const result = await ingestEmail(message, TEST_ENV, DB, BUCKET);
    expect(result).toMatchObject({ status: "rejected", reason: "unknown_recipient" });
    expect(rejects.length).toBeGreaterThan(0);
    expect(await countMessages()).toBe(0);
    const alias = await DB.prepare(
      `SELECT 1 AS x FROM aliases WHERE address='who-is-this@notify.example'`,
    ).first();
    expect(alias).toBeNull();
  });

  it("rejects mail to a DISABLED alias while keeping its history", async () => {
    await seedAlias("off@notify.example", "DISABLED");
    const { message } = makeMessage(
      "off@notify.example",
      emailRaw({ subject: "x", body: "y", messageId: "m3", to: "off@notify.example" }),
    );
    const result = await ingestEmail(message, TEST_ENV, DB, BUCKET);
    expect(result.status).toBe("rejected");
    expect(await countMessages()).toBe(0);
  });

  it("dedupes the same event redelivered twice", async () => {
    await seedAlias("dup@notify.example");
    const raw = emailRaw({
      subject: "dup",
      body: "code 112233",
      messageId: "m4",
      to: "dup@notify.example",
    });
    const first = await ingestEmail(
      makeMessage("dup@notify.example", raw).message,
      TEST_ENV,
      DB,
      BUCKET,
    );
    const second = await ingestEmail(
      makeMessage("dup@notify.example", raw).message,
      TEST_ENV,
      DB,
      BUCKET,
    );
    expect(first.status).toBe("stored");
    expect(second.status).toBe("duplicate");
    expect(await countMessages()).toBe(1);
  });

  it("rejects messages over the configured size cap", async () => {
    await seedAlias("big@notify.example");
    const smallEnv = { ...TEST_ENV, MAX_MESSAGE_BYTES: "32" } as Env;
    const raw = emailRaw({
      subject: "big",
      body: "x".repeat(5000),
      messageId: "m5",
      to: "big@notify.example",
    });
    const { message, rejects } = makeMessage("big@notify.example", raw);
    const result = await ingestEmail(message, smallEnv, DB, BUCKET);
    expect(result).toMatchObject({ status: "rejected", reason: "too_large" });
    expect(rejects.length).toBeGreaterThan(0);
    expect(await countMessages()).toBe(0);
  });

  it("records an aligned DMARC pass from raw MIME as UNVERIFIED", async () => {
    await seedAlias("auth-ok@notify.example");
    const raw = emailRaw({
      subject: "Your code",
      body: "Your GitHub verification code is 445566.",
      messageId: "a1",
      to: "auth-ok@notify.example",
      from: "GitHub <noreply@github.com>",
      authResults: [
        "mailer.github.net; spf=pass smtp.mailfrom=github.net; dkim=pass header.d=github.com; dmarc=pass header.from=github.com",
      ],
    });
    const result = await ingestEmail(
      makeMessage("auth-ok@notify.example", raw, "bounce@github.net").message,
      TEST_ENV,
      DB,
      BUCKET,
    );
    expect(result.status).toBe("stored");
    const row = await DB.prepare(`SELECT auth_verdict, auth_json FROM messages`).first<{
      auth_verdict: string;
      auth_json: string;
    }>();
    expect(row?.auth_verdict).toBe("UNVERIFIED");
    expect(row?.auth_json).toContain("dmarc");
  });

  it("does not mark a raw dmarc=fail message as SPOOFED under the default warn policy", async () => {
    await seedAlias("auth-bad@notify.example");
    const raw = emailRaw({
      subject: "Verify now",
      body: "Your code is 778899",
      messageId: "a2",
      to: "auth-bad@notify.example",
      from: "GitHub <security@github.com>",
      authResults: [
        "evil.server; dkim=pass header.d=evil.example; dmarc=fail header.from=github.com",
      ],
    });
    const result = await ingestEmail(
      makeMessage("auth-bad@notify.example", raw, "spam@evil.example").message,
      TEST_ENV,
      DB,
      BUCKET,
    );
    expect(result.status).toBe("stored");
    const row = await DB.prepare(`SELECT auth_verdict FROM messages`).first<{
      auth_verdict: string;
    }>();
    expect(row?.auth_verdict).toBe("UNVERIFIED");
  });

  it("does not reject on a raw dmarc=fail even when the domain policy is REJECT", async () => {
    const domainId = await seedAlias("auth-reject@notify.example");
    await DB.prepare(`UPDATE domains SET auth_policy = 'REJECT' WHERE id = ?1`)
      .bind(domainId)
      .run();
    const raw = emailRaw({
      subject: "Verify now",
      body: "Your code is 101010",
      messageId: "a3",
      to: "auth-reject@notify.example",
      from: "GitHub <security@github.com>",
      authResults: ["evil.server; dmarc=fail header.from=github.com"],
    });
    const { message, rejects } = makeMessage(
      "auth-reject@notify.example",
      raw,
      "spam@evil.example",
    );
    const result = await ingestEmail(message, TEST_ENV, DB, BUCKET);
    expect(result).toMatchObject({ status: "stored", verdict: "UNVERIFIED" });
    expect(rejects).toHaveLength(0);
    expect(await countMessages()).toBe(1);
  });

  it("never trusts a self-authored Authentication-Results pass", async () => {
    await seedAlias("auth-lie@notify.example");
    const raw = emailRaw({
      subject: "Look, I am verified",
      body: "Your code is 212121",
      messageId: "a4",
      to: "auth-lie@notify.example",
      from: "GitHub <security@github.com>",
      authResults: [
        "attacker.example; spf=pass smtp.mailfrom=attacker.example; dkim=pass header.d=attacker.example",
      ],
    });
    await ingestEmail(
      makeMessage("auth-lie@notify.example", raw, "x@attacker.example").message,
      TEST_ENV,
      DB,
      BUCKET,
    );
    const row = await DB.prepare(`SELECT auth_verdict FROM messages`).first<{
      auth_verdict: string;
    }>();
    // Nothing in a sender-controlled header can independently establish sender identity.
    expect(row?.auth_verdict).toBe("UNVERIFIED");
  });
});

describe("search: FTS5 text + code + alias matching", () => {
  async function deliver(to: string, subject: string, body: string, messageId: string) {
    const raw = emailRaw({ subject, body, messageId, to });
    await ingestEmail(makeMessage(to, raw).message, TEST_ENV, DB, BUCKET);
  }

  // Searching spans filed mail too; `archived` only narrows the working list.
  const list = (q: string) =>
    listMessages(DB, { filter: "all", archived: "all", limit: 10, offset: 0, q });

  it("finds by words, by exact OTP, and by alias address", async () => {
    await seedAlias("search@notify.example");
    await DB.prepare(
      `UPDATE aliases SET label = 'GitHub sign-in' WHERE address = 'search@notify.example'`,
    ).run();
    await deliver(
      "search@notify.example",
      "Please verify your device",
      "Your GitHub verification code is 55905149.",
      "s1",
    );
    await deliver("search@notify.example", "Weekly digest", "Nothing worth reading.", "s2");

    expect((await list("verify device")).total).toBe(1);
    expect((await list("digest")).total).toBe(1);
    expect((await list("55905149")).total).toBe(1);
    expect((await list("search@notify.example")).total).toBe(2);
    expect((await list("sign-in")).total).toBe(2);
    expect((await list("nothing-matches-this")).total).toBe(0);
  });

  it("survives query strings that are FTS5 syntax attacks", async () => {
    await seedAlias("safe@notify.example");
    await deliver("safe@notify.example", "hello world", "body", "s3");
    for (const q of ['"(unbalanced', "AND OR NOT", "ne*;x", "col:hello", '"', "NAAaA", "-"]) {
      const r = await list(q);
      expect(r.total).toBeLessThanOrEqual(1);
    }
  });

  it("removes the index row together with the message", async () => {
    await seedAlias("gone@notify.example");
    await deliver("gone@notify.example", "temporary notice", "body", "s4");
    expect((await list("temporary")).total).toBe(1);
    const row = await DB.prepare(
      `SELECT id FROM messages WHERE subject = 'temporary notice'`,
    ).first<{ id: string }>();
    await deleteMessage(DB, row!.id);
    expect((await list("temporary")).total).toBe(0);
  });
});

/*
 * The queue split. Staging writes the R2 objects first, so the D1 commit — the step that
 * used to be able to lose a message with nothing left to retry from — can be redelivered
 * against the same input.
 */
describe("staged ingest and its commit", () => {
  it("stages to R2 without committing, and the job carries no message content", async () => {
    await seedAlias("stage1@notify.example");
    const { message } = makeMessage(
      "stage1@notify.example",
      emailRaw({
        subject: "Sign in code",
        body: "Your code is 246813.",
        messageId: "st1",
        to: "stage1@notify.example",
      }),
    );

    const staged = await stageEmail(message, TEST_ENV, DB, BUCKET);
    expect(staged.status).toBe("staged");
    if (staged.status !== "staged") return;
    expect(await countMessages()).toBe(0);

    // A dead-lettered job must not become a second, unauthenticated copy of somebody's
    // mail, so it carries keys and addressing only.
    const wire = JSON.stringify(staged.job);
    expect(wire).not.toContain("Sign in code");
    expect(wire).not.toContain("246813");
    expect(staged.job.rawKey).toMatch(/^raw\//);
    expect(staged.job.parsedKey).toMatch(/^parsed\//);

    const committed = await commitIngest(staged.job, DB, BUCKET);
    expect(committed.status).toBe("stored");
    const row = await DB.prepare(`SELECT extracted_codes_json FROM messages`).first<{
      extracted_codes_json: string;
    }>();
    // Derived at commit from the staged bytes, not shipped across the queue.
    expect(row?.extracted_codes_json).toContain("246813");
  });

  it("re-delivery of the same job cannot store the message twice", async () => {
    await seedAlias("twice@notify.example");
    const { message } = makeMessage(
      "twice@notify.example",
      emailRaw({
        subject: "One",
        body: "Your code is 111111.",
        messageId: "tw",
        to: "twice@notify.example",
      }),
    );
    const staged = await stageEmail(message, TEST_ENV, DB, BUCKET);
    if (staged.status !== "staged") throw new Error("expected staged");

    expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
    expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("duplicate");
    expect(await countMessages()).toBe(1);
    expect(await getObject(BUCKET, staged.job.rawKey)).not.toBeNull();
    expect(await getObject(BUCKET, staged.job.parsedKey)).not.toBeNull();
  });

  it("a failed commit leaves the staged objects alone so the retry has the same input", async () => {
    await seedAlias("flaky@notify.example");
    const { message } = makeMessage(
      "flaky@notify.example",
      emailRaw({
        subject: "Retry me",
        body: "Your code is 333444.",
        messageId: "fl",
        to: "flaky@notify.example",
      }),
    );
    const staged = await stageEmail(message, TEST_ENV, DB, BUCKET);
    if (staged.status !== "staged") throw new Error("expected staged");

    let busy = true;
    const flaky = new Proxy(DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (busy && sql.includes("INSERT INTO messages")) throw new Error("d1 busy");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, target);
      },
    }) as unknown as D1Database;

    await expect(commitIngest(staged.job, flaky, BUCKET)).rejects.toThrow("d1 busy");
    // The whole point: nothing was destroyed, so the redelivery can finish the job.
    expect(await getObject(BUCKET, staged.job.rawKey)).not.toBeNull();
    expect(await getObject(BUCKET, staged.job.parsedKey)).not.toBeNull();
    expect(await countMessages()).toBe(0);

    busy = false;
    expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
    expect(await countMessages()).toBe(1);
  });

  it("a vanished staged object is a failure, not a silently dropped message", async () => {
    await seedAlias("ghost@notify.example");
    const { message } = makeMessage(
      "ghost@notify.example",
      emailRaw({ subject: "Ghost", body: "body", messageId: "gh", to: "ghost@notify.example" }),
    );
    const staged = await stageEmail(message, TEST_ENV, DB, BUCKET);
    if (staged.status !== "staged") throw new Error("expected staged");
    await BUCKET.delete(staged.job.parsedKey);

    // Throwing sends the job back for retry and eventually to the dead-letter queue,
    // where the raw .eml is still retrievable by key.
    await expect(commitIngest(staged.job, DB, BUCKET)).rejects.toThrow("staged_parse_missing");
    expect(await countMessages()).toBe(0);
  });

  it("the email handler stages and posts exactly one job for the consumer", async () => {
    await seedAlias("handler@notify.example");
    const { message } = makeMessage(
      "handler@notify.example",
      emailRaw({
        subject: "Through the handler",
        body: "Your code is 987654.",
        messageId: "hd",
        to: "handler@notify.example",
      }),
    );
    bindings.queue.reset();

    await worker.email(message as never, TEST_ENV);
    expect(bindings.queue.sent).toHaveLength(1);
    expect(await countMessages()).toBe(0);

    expect((await commitIngest(bindings.queue.sent[0]!, DB, BUCKET)).status).toBe("stored");
    expect(await countMessages()).toBe(1);
  });

  it("keeps staged objects when queue send fails ambiguously after accepting the job", async () => {
    await seedAlias("ambiguous@notify.example");
    let accepted: IngestJob | undefined;
    const { message } = makeMessage(
      "ambiguous@notify.example",
      emailRaw({
        subject: "Ambiguous queue",
        body: "body",
        messageId: "aq1",
        to: "ambiguous@notify.example",
      }),
    );
    const env = {
      ...TEST_ENV,
      MAIL_INGEST_QUEUE: {
        send: async (job: IngestJob) => {
          accepted = job;
          throw new Error("response lost after queue acceptance");
        },
      },
    } as unknown as Env;

    await expect(worker.email(message as never, env)).rejects.toThrow("response lost");
    expect(accepted).toBeDefined();
    expect(await getObject(BUCKET, accepted!.rawKey)).not.toBeNull();
    expect(await getObject(BUCKET, accepted!.parsedKey)).not.toBeNull();
    expect((await commitIngest(accepted!, DB, BUCKET)).status).toBe("stored");
    await deleteMessage(DB, accepted!.messageId);
    await BUCKET.delete([accepted!.rawKey, accepted!.parsedKey]);
  });
});

/*
 * The consumer itself. Its contract is what makes the retry safe: a job that commits is
 * acknowledged, a job that fails is retried with its staged objects untouched, and a
 * duplicate is acknowledged rather than retried forever.
 */
describe("ingest queue consumer", () => {
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  async function stagedJob(address: string, subject: string, body: string, id: string) {
    await seedAlias(address);
    const { message } = makeMessage(
      address,
      emailRaw({ subject, body, messageId: id, to: address }),
    );
    const staged = await stageEmail(message, TEST_ENV, DB, BUCKET);
    if (staged.status !== "staged") throw new Error("expected staged");
    return staged.job;
  }

  function fakeBatch(jobs: unknown[]) {
    const decisions: string[] = [];
    const messages = jobs.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      attempts: 1,
      ackTimeoutMs: 30_000,
      body,
      ack: () => void decisions.push(`ack:${i}`),
      retry: () => void decisions.push(`retry:${i}`),
      respond: async () => undefined,
    }));
    return {
      messages,
      decisions,
      ackAll: () => void decisions.push("ackAll"),
      retryAll: () => void decisions.push("retryAll"),
    };
  }

  it("acknowledges a job it commits", async () => {
    const job = await stagedJob(
      "consume1@notify.example",
      "Consume me",
      "Your code is 123321.",
      "c1",
    );
    const batch = fakeBatch([job]);

    await worker.queue(batch as never, TEST_ENV, ctx);

    expect(batch.decisions).toEqual(["ack:0"]);
    expect(await countMessages()).toBe(1);
    expect(await getObject(BUCKET, job.rawKey)).not.toBeNull();
    expect(await getObject(BUCKET, job.parsedKey)).not.toBeNull();
  });

  it("retries a job whose commit failed, with the staged input intact", async () => {
    const job = await stagedJob("consume2@notify.example", "Broken commit", "body", "c2");
    await BUCKET.delete(job.parsedKey);
    const batch = fakeBatch([job]);

    await worker.queue(batch as never, TEST_ENV, ctx);

    expect(batch.decisions).toEqual(["retry:0"]);
    expect(await countMessages()).toBe(0);
    // The raw is still there, so the redelivery (and later the dead-letter record) can
    // still be resolved back to the actual message.
    expect(await getObject(BUCKET, job.rawKey)).not.toBeNull();
  });

  it("acknowledges a duplicate instead of retrying it forever", async () => {
    const job = await stagedJob("consume3@notify.example", "Twice delivered", "body", "c3");
    expect((await commitIngest(job, DB, BUCKET)).status).toBe("stored");

    const batch = fakeBatch([job]);
    await worker.queue(batch as never, TEST_ENV, ctx);

    expect(batch.decisions).toEqual(["ack:0"]);
    expect(await countMessages()).toBe(1);
  });

  it("does not let one poisoned job stop the rest of the batch", async () => {
    const good = await stagedJob("consume4@notify.example", "Good job", "body", "c4");
    const bad = { ...good, messageId: "poison", parsedKey: "parsed/does-not-exist.json" };

    const batch = fakeBatch([bad, good]);
    await worker.queue(batch as never, TEST_ENV, ctx);

    expect(batch.decisions).toEqual(["retry:0", "ack:1"]);
    expect(await countMessages()).toBe(1);
  });
});

/*
 * Rules run at commit, after the message row exists. The property worth pinning is that
 * they only ever organise: mail is filed and stays retrievable, and a rule that breaks
 * cannot take the message with it.
 */
describe("rules at commit", () => {
  async function addRule(match: object, action: object, enabled = 1) {
    const id = crypto.randomUUID();
    await DB.prepare(
      `INSERT INTO rules (id, enabled, match_json, action_json, hits, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)`,
    )
      .bind(id, enabled, JSON.stringify(match), JSON.stringify(action), new Date().toISOString())
      .run();
    return id;
  }

  async function deliver(
    to: string,
    subject: string,
    body: string,
    messageId: string,
    from = "noreply@github.com",
  ) {
    const { message } = makeMessage(to, emailRaw({ subject, body, messageId, to }), from);
    return ingestEmail(message, TEST_ENV, DB, BUCKET);
  }

  it("files matching mail and leaves everything else in the working list", async () => {
    await seedAlias("rules@notify.example");
    await addRule({ senderDomain: "mailchimp.com" }, { archive: true, tag: "newsletters" });

    await deliver(
      "rules@notify.example",
      "Weekly digest",
      "Hello from Mailchimp",
      "ru1",
      "news@mailchimp.com",
    );
    await deliver("rules@notify.example", "Your code is 435829", "code", "ru2");

    const row = await DB.prepare(
      `SELECT archived, rule_tag, applied_rule_note FROM messages WHERE subject = 'Weekly digest'`,
    ).first<{ archived: number; rule_tag: string; applied_rule_note: string }>();
    expect(row?.archived).toBe(1);
    expect(row?.rule_tag).toBe("newsletters");
    expect(row?.applied_rule_note).toContain("mailchimp.com");

    const kept = await DB.prepare(
      `SELECT archived FROM messages WHERE subject LIKE 'Your code%'`,
    ).first<{ archived: number }>();
    expect(kept?.archived).toBe(0);

    const active = await listMessages(DB, {
      filter: "all",
      archived: "active",
      limit: 10,
      offset: 0,
    });
    expect(active.items.map((m) => m.subject)).toEqual(["Your code is 435829"]);
    const filed = await listMessages(DB, {
      filter: "all",
      archived: "archived",
      limit: 10,
      offset: 0,
    });
    expect(filed.items[0]?.ruleTag).toBe("newsletters");
    expect(filed.items[0]?.archived).toBe(true);
  });

  it("counts a hit, and stops firing once the rule is paused", async () => {
    await seedAlias("pause@notify.example");
    const id = await addRule({ subjectContains: "invoice" }, { archive: true });

    await deliver("pause@notify.example", "Your invoice", "body", "pa1");
    expect(
      (
        await DB.prepare(`SELECT hits AS h FROM rules WHERE id = ?1`)
          .bind(id)
          .first<{ h: number }>()
      )?.h,
    ).toBe(1);

    await DB.prepare(`UPDATE rules SET enabled = 0 WHERE id = ?1`).bind(id).run();
    await deliver("pause@notify.example", "Another invoice", "body", "pa2");

    expect(
      (
        await DB.prepare(`SELECT hits AS h FROM rules WHERE id = ?1`)
          .bind(id)
          .first<{ h: number }>()
      )?.h,
    ).toBe(1);
    const stillActive = await DB.prepare(
      `SELECT archived AS a FROM messages WHERE subject = 'Another invoice'`,
    ).first<{ a: number }>();
    expect(stillActive?.a).toBe(0);
  });

  it("keeps the message when a rule cannot be applied", async () => {
    await seedAlias("broken@notify.example");
    await addRule({ senderDomain: "broken.example" }, { archive: true });
    // The core transaction is durable, but a failed optional stage remains retryable.
    await DB.prepare(`ALTER TABLE rules RENAME TO rules_hidden`).run();
    const { message } = makeMessage(
      "broken@notify.example",
      emailRaw({ subject: "Fragile", body: "body", messageId: "br1", to: "broken@notify.example" }),
      "x@broken.example",
    );
    const staged = await stageEmail(message, TEST_ENV, DB, BUCKET);
    if (staged.status !== "staged") throw new Error("expected staged");
    try {
      await expect(commitIngest(staged.job, DB, BUCKET)).rejects.toThrow(/rules/);
      expect(await countMessages()).toBe(1);
      expect(
        await DB.prepare(`SELECT ingest_status FROM messages WHERE id = ?1`)
          .bind(staged.job.messageId)
          .first<{ ingest_status: string }>(),
      ).toMatchObject({ ingest_status: "RULES_PENDING" });
    } finally {
      await DB.prepare(`ALTER TABLE rules_hidden RENAME TO rules`).run();
    }
    expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
    await BUCKET.delete(staged.keys);
  });

  it("reports senders that hold more than one alias", async () => {
    const domainId = await seedAlias("one@notify.example");
    // Two aliases on the one domain: `domains.name` is unique, so the second is an alias
    // row rather than a second call to seedAlias.
    await DB.prepare(
      `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, 'two', 'two@notify.example', 'ACTIVE')`,
    )
      .bind(crypto.randomUUID(), domainId)
      .run();
    await deliver("one@notify.example", "Hi", "body", "ar1", "hello@service.example");
    await deliver("two@notify.example", "Hi again", "body", "ar2", "hello@service.example");
    await deliver("two@notify.example", "Alone here", "body", "ar3", "solo@other.example");

    const report = await addressReuseReport(DB);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ senderDomain: "service.example", aliases: 2, messages: 2 });
  });
});
