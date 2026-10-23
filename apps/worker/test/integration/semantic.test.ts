import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { ingestEmail } from "../../src/mail/ingest";
import { deleteMessage } from "../../src/db/messages";
import { listMessages } from "../../src/db/messages";
import { requestMessageDeletion, drainDeletionJobs } from "../../src/db/deletions";
import {
  backfill,
  embedText,
  indexIfEnabled,
  indexStoredMessage,
  indexedCount,
  purgeIndex,
  removeIndex,
  searchMessageIds,
  semanticEnabled,
  setSemanticEnabled,
} from "../../src/lib/semantic";
import { getTestBindings, type TestBindings } from "./_mf";

/**
 * Semantic search against a fake AI + Vectorize. The point is not the model — it is that
 * nothing is copied anywhere until the owner says so, that what is copied can be counted,
 * and that turning it off actually removes it.
 */

function fakeStore() {
  const vectors = new Map<string, number[]>();
  const deleteBatchSizes: number[] = [];
  const ai = {
    run: async (_model: string, input: { text: string[] | string }) => {
      const texts = Array.isArray(input.text) ? input.text : [input.text];
      // A deterministic "embedding": the first eight bytes of a hash, repeated. Enough to
      // prove the plumbing without pretending to be a model.
      return {
        data: texts.map((t) =>
          Array.from({ length: 1024 }, (_, i) => (t.charCodeAt(i % t.length) + i) / 1000),
        ),
      };
    },
  };
  const vectorize = {
    upsert: async (args: Array<{ id: string; values: number[] }>) => {
      for (const a of args) vectors.set(a.id, a.values);
      return { count: args.length, upsertCount: args.length, insertCount: 0 };
    },
    deleteByIds: async (ids: string[]) => {
      deleteBatchSizes.push(ids.length);
      for (const id of ids) vectors.delete(id);
      return { deleteCount: ids.length };
    },
    query: async () => ({
      matches: [...vectors.keys()].map((id) => ({ id, score: 0.9, namespace: "" })),
    }),
  };
  return { vectors, ai, vectorize, deleteBatchSizes };
}

let bindings: TestBindings;
let DB: D1Database;
let BUCKET: R2Bucket;
let store: ReturnType<typeof fakeStore>;
let ENV: Env;

function withBindings(over: Partial<Env> = {}): Env {
  return { ...bindings.env, AI: store.ai, VECTORIZE: store.vectorize, ...over } as unknown as Env;
}

function emailRaw(to: string, subject: string, body: string, messageId: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: Shop <receipts@phone-shop.example>",
      `To: ${to}`,
      `Subject: ${subject}`,
      `Message-ID: <${messageId}@phone-shop.example>`,
      "Date: Fri, 19 Sep 2026 12:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "",
    ].join("\r\n"),
  );
}

async function deliver(to: string, subject: string, body: string, messageId: string) {
  const raw = emailRaw(to, subject, body, messageId);
  return ingestEmail(
    {
      from: "receipts@phone-shop.example",
      to,
      headers: new Headers(),
      raw: new Response(raw).body as ReadableStream<Uint8Array>,
      rawSize: raw.byteLength,
      setReject: () => {},
    },
    ENV,
    DB,
    BUCKET,
  );
}

async function seedAlias(address: string) {
  const domainId = crypto.randomUUID();
  const aliasId = crypto.randomUUID();
  const [local, domain] = address.split("@");
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status) VALUES (?1, ?2, ?3, 'active', 'full', 'READY')`,
  )
    .bind(domainId, `zone-${domainId.slice(0, 8)}`, domain)
    .run();
  await DB.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, ?3, ?4, 'ACTIVE')`,
  )
    .bind(aliasId, domainId, local, address)
    .run();
  return { domainId, aliasId };
}

beforeAll(async () => {
  bindings = await getTestBindings();
  DB = bindings.db;
  BUCKET = bindings.bucket;
});

beforeEach(async () => {
  store = fakeStore();
  ENV = withBindings();
  await DB.prepare(`DELETE FROM semantic_index_leases`).run();
  await DB.prepare(`DELETE FROM deletion_jobs`).run();
  await DB.prepare(`DELETE FROM attachments`).run();
  await DB.prepare(`DELETE FROM messages`).run();
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM domains`).run();
  await DB.prepare(`DELETE FROM app_settings`).run();
});

afterAll(async () => {
  await bindings?.dispose();
});

describe("embedText", () => {
  it("leads with who sent it and what it was called", () => {
    expect(embedText({ sender: "Shop <a@b.example>", subject: "Receipt", body: "thanks" })).toBe(
      "Shop <a@b.example> · Receipt\nthanks",
    );
  });

  it("collapses whitespace and caps the body so a long footer cannot crowd out the substance", () => {
    const long = "a\n\n  b " + "z".repeat(2000);
    const out = embedText({ sender: null, subject: null, body: long });
    expect(out.startsWith("a b zzz")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(900 + 40);
  });

  it("is empty when there is nothing to say, and the indexer refuses to store that", async () => {
    expect(embedText({ sender: null, subject: null, body: "   " })).toBe("");
    await seedAlias("empty@notify.example");
    await setSemanticEnabled(DB, true);
    expect(await indexMessageTextOnly()).toBe(false);
  });
});

async function indexMessageTextOnly(): Promise<boolean> {
  const { indexMessage } = await import("../../src/lib/semantic");
  return indexMessage(ENV, "no-such-id", { subject: null, sender: null, body: "  " });
}

describe("the opt-in", () => {
  it("is off on a fresh database, and nothing is indexed while it is off", async () => {
    await seedAlias("quiet@notify.example");
    expect(await semanticEnabled(DB)).toBe(false);

    await deliver("quiet@notify.example", "Invoice 42", "Total due 12.00", "q1");
    await indexIfEnabled(ENV, "whatever");
    expect(store.vectors.size).toBe(0);
    expect((await indexedCount(DB)).indexed).toBe(0);
  });

  it("indexes new mail once the owner turns it on, and reports how much", async () => {
    await seedAlias("loud@notify.example");
    await setSemanticEnabled(DB, true);

    const stored = await deliver("loud@notify.example", "Invoice 42", "Total due 12.00", "l1");
    expect(stored.status).toBe("stored");
    const id = stored.status === "stored" ? stored.messageId : "";

    await indexIfEnabled(ENV, id);
    expect(store.vectors.has(id)).toBe(true);
    expect(await indexedCount(DB)).toEqual({ indexed: 1, total: 1 });
  });

  it("defers deletion while a Vectorize upsert is in flight", async () => {
    await seedAlias("race@notify.example");
    await setSemanticEnabled(DB, true);
    const stored = await deliver("race@notify.example", "Racing index", "body", "race-1");
    if (stored.status !== "stored") throw new Error("message was not stored");

    let started!: () => void;
    let release!: () => void;
    const upsertStarted = new Promise<void>((resolve) => (started = resolve));
    const upsertGate = new Promise<void>((resolve) => (release = resolve));
    const vectors = store.vectors;
    const vectorize = {
      ...store.vectorize,
      upsert: async (entries: Array<{ id: string; values: number[] }>) => {
        started();
        await upsertGate;
        for (const entry of entries) vectors.set(entry.id, entry.values);
        return { count: entries.length, upsertCount: entries.length, insertCount: 0 };
      },
    } as unknown as Env["VECTORIZE"];
    const env = { ...ENV, VECTORIZE: vectorize } as Env;
    const indexing = indexStoredMessage(env, stored.messageId);
    await upsertStarted;

    const queued = await requestMessageDeletion(DB, stored.messageId);
    expect(queued).toMatchObject({ found: true, state: "PENDING" });
    const rawKey = await DB.prepare(`SELECT raw_r2_key FROM messages WHERE id = ?1`)
      .bind(stored.messageId)
      .first<string>("raw_r2_key");
    const job = await DB.prepare(`SELECT vector_id FROM deletion_jobs WHERE message_id = ?1`)
      .bind(stored.messageId)
      .first<{ vector_id: string | null }>();
    expect(job?.vector_id).toBe(stored.messageId);

    const waiting = await drainDeletionJobs(env);
    expect(waiting.deferred).toBe(1);
    expect(
      await DB.prepare(`SELECT id FROM messages WHERE id = ?1`).bind(stored.messageId).first(),
    ).not.toBeNull();
    expect(await BUCKET.get(rawKey!)).not.toBeNull();

    release();
    expect(await indexing).toBe(false);
    expect(vectors.has(stored.messageId)).toBe(true);
    await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?2 WHERE message_id = ?1`)
      .bind(stored.messageId, new Date(0).toISOString())
      .run();
    const completed = await drainDeletionJobs(env);
    expect(completed.completed).toBe(1);
    expect(vectors.has(stored.messageId)).toBe(false);
    expect(
      await DB.prepare(`SELECT id FROM messages WHERE id = ?1`).bind(stored.messageId).first(),
    ).toBeNull();
    expect(await BUCKET.get(rawKey!)).toBeNull();
  });

  it("finds by meaning through the same list, without losing keyword matches", async () => {
    await seedAlias("find@notify.example");
    await setSemanticEnabled(DB, true);
    const stored = await deliver("find@notify.example", "Phone shop receipt", "b", "f1");
    const id = stored.status === "stored" ? stored.messageId : "";
    await indexStoredMessage(ENV, id);

    const ids = await searchMessageIds(ENV, "the invoice from the phone place");
    expect(ids).toContain(id);

    const merged = await listMessages(DB, {
      filter: "all",
      archived: "active",
      limit: 10,
      offset: 0,
      q: "phone",
      semanticIds: ids,
    });
    expect(merged.items.map((m) => m.id)).toContain(id);
  });

  it("backfills what predates the setting", async () => {
    await seedAlias("old@notify.example");
    await deliver("old@notify.example", "Old mail", "b", "o1");
    await deliver("old@notify.example", "Older mail", "b", "o2");
    await setSemanticEnabled(DB, true);

    const result = await backfill(ENV, 50);
    expect(result.indexed).toBe(2);
    expect(result.remaining).toBe(0);
    expect(store.vectors.size).toBe(2);
  });

  it("turning off deletes the vectors, not just the switch", async () => {
    await seedAlias("off@notify.example");
    await setSemanticEnabled(DB, true);
    const stored = await deliver("off@notify.example", "Temporary", "b", "x1");
    const id = stored.status === "stored" ? stored.messageId : "";
    await indexStoredMessage(ENV, id);
    expect(store.vectors.size).toBe(1);

    await setSemanticEnabled(DB, false);
    const purged = await purgeIndex(ENV);
    expect(purged).toBe(1);
    expect(store.vectors.size).toBe(0);
    expect((await indexedCount(DB)).indexed).toBe(0);
    expect(await semanticEnabled(DB)).toBe(false);
  });

  it("purges indexed vectors in bounded pages", async () => {
    const { domainId, aliasId } = await seedAlias("many@notify.example");
    const ids = Array.from({ length: 205 }, () => crypto.randomUUID());
    for (let start = 0; start < ids.length; start += 25) {
      const batch = ids.slice(start, start + 25);
      await DB.batch(
        batch.map((id, index) =>
          DB.prepare(
            `INSERT INTO messages (id, domain_id, alias_id, dedupe_key, envelope_to, received_at,
              raw_r2_key, embedded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
          ).bind(
            id,
            domainId,
            aliasId,
            `indexed-${id}`,
            "many@notify.example",
            new Date(Date.now() + start + index).toISOString(),
            `raw/${id}`,
            new Date().toISOString(),
          ),
        ),
      );
      for (const id of batch) store.vectors.set(id, [0]);
    }

    expect(await purgeIndex(ENV)).toBe(ids.length);
    expect(store.vectors.size).toBe(0);
    expect(store.deleteBatchSizes).toEqual([100, 100, 5]);
    expect((await indexedCount(DB)).indexed).toBe(0);
  });

  it("removes the embedding when the owner deletes the message", async () => {
    await seedAlias("gone@notify.example");
    await setSemanticEnabled(DB, true);
    const stored = await deliver("gone@notify.example", "Delete me", "b", "d1");
    const id = stored.status === "stored" ? stored.messageId : "";
    await indexStoredMessage(ENV, id);

    await deleteMessage(DB, id);
    await removeIndex(ENV, id);
    expect(store.vectors.size).toBe(0);
  });

  it("does nothing at all when the bindings are missing", async () => {
    await seedAlias("plain@notify.example");
    await setSemanticEnabled(DB, true);
    const bare = { ...bindings.env } as unknown as Env;
    const stored = await deliver("plain@notify.example", "No AI here", "b", "n1");
    const id = stored.status === "stored" ? stored.messageId : "";
    await expect(indexStoredMessage(bare, id)).resolves.toBe(false);
    await expect(searchMessageIds(bare, "anything")).resolves.toEqual([]);
    await expect(purgeIndex(bare)).resolves.toBe(0);
  });
});
