import { visibleMessageSql } from "../db/visibility";
import type { Env } from "../env";
import { getSetting, setSetting } from "../db/settings";
import { recordLateSemanticWrite } from "../db/deletions";
import { newId } from "./util";
import { log } from "./logging";

export const SEMANTIC_SETTING = "semanticSearch";
/** Enough of the body to match on meaning, short enough to stay cheap. */
export const EMBED_CHARS = 900;
/** Vectorize accepts up to 100 ids per delete call. */
const DELETE_BATCH = 100;
const INDEX_LEASE_MS = 60_000;
const INDEX_HEARTBEAT_MS = 15_000;

const MODEL = "@cf/baai/bge-m3";
const DIMENSIONS = 1024;

export interface SemanticFacts {
  subject: string | null;
  sender: string | null;
  body: string | null;
}

/**
 * The text that becomes a vector. Sender and subject lead because that is how people ask
 * ("the invoice from X", "the code from the bank"), and the body is truncated rather than
 * dropped — a long footer should not push the actual sentence out of the embedding.
 */
export function embedText(f: SemanticFacts): string {
  const head = [f.sender ?? "", f.subject ?? ""].filter(Boolean).join(" · ");
  const body = (f.body ?? "").replace(/\s+/g, " ").trim().slice(0, EMBED_CHARS);
  return `${head}\n${body}`.trim();
}

export async function semanticEnabled(db: D1Database): Promise<boolean> {
  return (await getSetting(db, SEMANTIC_SETTING)) === "on";
}

export async function setSemanticEnabled(db: D1Database, on: boolean): Promise<void> {
  await setSetting(db, SEMANTIC_SETTING, on ? "on" : "off");
}

function ready(
  env: Env,
): env is Env & { AI: NonNullable<Env["AI"]>; VECTORIZE: NonNullable<Env["VECTORIZE"]> } {
  return !!env.AI && !!env.VECTORIZE;
}

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const res = (await env.AI!.run(MODEL as never, { text: texts })) as unknown as {
    data?: number[][];
  };
  const vectors = res?.data ?? [];
  if (vectors.length !== texts.length) throw new Error("embedding count mismatch");
  return vectors;
}

async function acquireIndexLease(env: Env, messageId: string): Promise<string | null> {
  const now = new Date().toISOString();
  const token = newId();
  const leaseUntil = new Date(Date.now() + INDEX_LEASE_MS).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO semantic_index_leases (message_id, token, lease_until)
     SELECT m.id, ?2, ?3 FROM messages m
     WHERE m.id = ?1 AND ${visibleMessageSql("m")}
       AND NOT EXISTS (
         SELECT 1 FROM deletion_jobs j WHERE j.job_type = 'MESSAGE' AND j.message_id = m.id
       )
     ON CONFLICT(message_id) DO UPDATE SET token = excluded.token, lease_until = excluded.lease_until
       WHERE semantic_index_leases.lease_until <= ?4`,
  )
    .bind(messageId, token, leaseUntil, now)
    .run();
  return result.meta.changes ? token : null;
}

async function renewIndexLease(env: Env, messageId: string, token: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE semantic_index_leases SET lease_until = ?3 WHERE message_id = ?1 AND token = ?2`,
  )
    .bind(messageId, token, new Date(Date.now() + INDEX_LEASE_MS).toISOString())
    .run();
}

async function releaseIndexLease(env: Env, messageId: string, token: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM semantic_index_leases WHERE message_id = ?1 AND token = ?2`)
    .bind(messageId, token)
    .run();
}

async function finishIndexWrite(env: Env, messageId: string, token: string): Promise<boolean> {
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE messages SET embedded_at = ?2 WHERE id = ?1 AND ${visibleMessageSql("messages")}
           AND EXISTS (SELECT 1 FROM semantic_index_leases WHERE message_id = ?1 AND token = ?3)`,
    ).bind(messageId, now, token),
    env.DB.prepare(
      `DELETE FROM semantic_index_leases WHERE message_id = ?1 AND token = ?2
           AND EXISTS (SELECT 1 FROM messages m WHERE m.id = ?1 AND ${visibleMessageSql("m")})`,
    ).bind(messageId, token),
  ]);
  if (results[0]?.meta.changes) return true;

  await recordLateSemanticWrite(env.DB, messageId);
  await releaseIndexLease(env, messageId, token);
  return false;
}

/**
 * Index one message. Best-effort by design: if the model or the index is unavailable the
 * mail is still stored and searchable by keyword, and `embedded_at` stays null so the
 * status screen reports the gap honestly instead of pretending it is indexed.
 */
export async function indexMessage(
  env: Env,
  messageId: string,
  facts: SemanticFacts,
): Promise<boolean> {
  if (!ready(env)) return false;
  const text = embedText(facts);
  if (!text) return false;
  let lease: string | null = null;
  try {
    const [vector] = await embed(env, [text]);
    if (!vector) return false;
    lease = await acquireIndexLease(env, messageId);
    if (!lease) return false;
    let renewal = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewal = renewal
        .then(() => renewIndexLease(env, messageId, lease!))
        .catch((err: unknown) => {
          log.warn("semantic_index_lease_renew_failed", {
            error: err instanceof Error ? err.message : "error",
          });
        });
    }, INDEX_HEARTBEAT_MS);
    try {
      await env.VECTORIZE!.upsert([
        { id: messageId, values: vector, metadata: { indexedAt: new Date().toISOString() } },
      ]);
      return await finishIndexWrite(env, messageId, lease);
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }
  } catch (err) {
    if (lease) {
      try {
        await recordLateSemanticWrite(env.DB, messageId);
      } catch (cleanupErr) {
        log.warn("semantic_late_write_repair_failed", {
          error: cleanupErr instanceof Error ? cleanupErr.message : "error",
        });
      }
      try {
        await releaseIndexLease(env, messageId, lease);
      } catch {
        // The durable lease remains for deletion cleanup to observe.
      }
    }
    log.warn("semantic_index_failed", { error: err instanceof Error ? err.message : "error" });
    return false;
  }
}

export async function removeIndex(env: Env, messageId: string): Promise<void> {
  if (!ready(env)) return;
  try {
    await env.VECTORIZE!.deleteByIds([messageId]);
  } catch (err) {
    log.warn("semantic_unindex_failed", { error: err instanceof Error ? err.message : "error" });
  }
}

export async function searchMessageIds(env: Env, query: string, limit = 25): Promise<string[]> {
  if (!ready(env) || !query.trim()) return [];
  try {
    const [vector] = await embed(env, [query.trim()]);
    if (!vector) return [];
    const matches = await env.VECTORIZE!.query(vector, { topK: limit, returnMetadata: "none" });
    return (matches.matches ?? []).map((m) => String(m.id));
  } catch (err) {
    log.warn("semantic_search_failed", { error: err instanceof Error ? err.message : "error" });
    return [];
  }
}

export async function indexedCount(db: D1Database): Promise<{ indexed: number; total: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(embedded_at IS NOT NULL), 0) AS indexed FROM messages m WHERE ${visibleMessageSql()}`,
    )
    .first<{ total: number; indexed: number }>();
  return { indexed: Number(row?.indexed ?? 0), total: Number(row?.total ?? 0) };
}

/** Everything currently indexed, so turning the feature off can remove exactly that. */
export async function indexedIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT id FROM messages WHERE embedded_at IS NOT NULL`)
    .all<{ id: string }>();
  return (results ?? []).map((r) => r.id);
}

/**
 * Delete every vector and clear the markers. Called when the owner turns the feature off,
 * so "off" means the copies are gone rather than merely unused.
 */
export async function purgeIndex(env: Env): Promise<number> {
  if (!ready(env)) return 0;
  let removed = 0;
  let afterId = "";
  while (true) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM messages WHERE embedded_at IS NOT NULL AND id > ?1 ORDER BY id LIMIT ?2`,
    )
      .bind(afterId, DELETE_BATCH)
      .all<{ id: string }>();
    const ids = (results ?? []).map((row) => row.id);
    if (ids.length === 0) break;
    await env.VECTORIZE!.deleteByIds(ids);
    const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ");
    await env.DB.prepare(`UPDATE messages SET embedded_at = NULL WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
    removed += ids.length;
    afterId = ids[ids.length - 1]!;
  }
  log.info("semantic_index_purged", { count: removed });
  return removed;
}

/**
 * Index one stored message by id, reading its own text back from R2. Used by the queue
 * consumer for new mail and by the backfill for mail that predates the setting, so both
 * go through the same path.
 */
export async function indexStoredMessage(env: Env, messageId: string): Promise<boolean> {
  if (!ready(env)) return false;
  const row = await env.DB.prepare(
    `SELECT subject, header_from, parsed_r2_key FROM messages m WHERE id = ?1 AND ${visibleMessageSql()}`,
  )
    .bind(messageId)
    .first<{ subject: string | null; header_from: string | null; parsed_r2_key: string | null }>();
  if (!row?.parsed_r2_key) return false;
  const obj = await env.MAIL_BUCKET.get(row.parsed_r2_key);
  if (!obj) return false;
  const parsed = (await obj.json()) as { text?: string | null };
  return indexMessage(env, messageId, {
    subject: row.subject,
    sender: row.header_from,
    body: parsed.text ?? null,
  });
}

/** Index a committed message when enabled; callers may retry while `embedded_at` is unset. */
export async function indexIfEnabled(env: Env, messageId: string): Promise<boolean> {
  try {
    if (!(await semanticEnabled(env.DB))) return true;
    return await indexStoredMessage(env, messageId);
  } catch (err) {
    log.warn("semantic_index_failed", { error: err instanceof Error ? err.message : "error" });
    return false;
  }
}

/** Index up to `batch` messages that were stored before the feature was turned on. */
export async function backfill(
  env: Env,
  batch = 50,
): Promise<{ indexed: number; remaining: number }> {
  if (!ready(env)) return { indexed: 0, remaining: 0 };
  const { results } = await env.DB.prepare(
    `SELECT id FROM messages m WHERE embedded_at IS NULL AND ${visibleMessageSql()} ORDER BY received_at DESC LIMIT ?1`,
  )
    .bind(batch)
    .all<{ id: string }>();

  let indexed = 0;
  for (const row of results ?? []) {
    if (await indexStoredMessage(env, row.id)) indexed += 1;
  }
  const counts = await indexedCount(env.DB);
  return { indexed, remaining: Math.max(0, counts.total - counts.indexed) };
}

export const EMBEDDING_MODEL = MODEL;
export const EMBEDDING_DIMENSIONS = DIMENSIONS;
