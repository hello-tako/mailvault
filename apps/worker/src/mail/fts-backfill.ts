import { getObject } from "../storage/r2";

/**
 * Give the search index the bodies of mail stored before migration 0022 (plan C1).
 *
 * Each message's plain text lives in its parsed copy in R2, so a batch is: find rows whose
 * `body` is still empty, read each parsed object once, and write the truncated text back.
 * The hourly cron calls this until nothing is left, then remembers "done" in app_settings —
 * no owner action, no window during which new mail is unsearchable (new mail indexes its
 * body at commit time).
 */

const BODY_CAP = 20_000;

export async function backfillFtsBodies(
  db: D1Database,
  bucket: R2Bucket,
  limit: number,
): Promise<{ processed: number; remaining: number }> {
  const { results } = await db
    .prepare(
      `SELECT f.message_id AS id, m.parsed_r2_key AS k
       FROM messages_fts f JOIN messages m ON m.id = f.message_id
       WHERE f.body = '' AND m.parsed_r2_key IS NOT NULL AND m.deletion_pending = 0
       LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: string; k: string }>();

  const statements: D1PreparedStatement[] = [];
  for (const row of results ?? []) {
    const parsed = await getObject(bucket, row.k)
      .then((obj) => (obj ? (obj.json() as Promise<{ text?: string }>) : null))
      .catch(() => null);
    statements.push(
      db
        .prepare(`UPDATE messages_fts SET body = ?2 WHERE message_id = ?1`)
        .bind(row.id, ((parsed?.text ?? "") as string).slice(0, BODY_CAP)),
    );
  }
  if (statements.length) await db.batch(statements);

  const left = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages_fts f JOIN messages m ON m.id = f.message_id
       WHERE f.body = '' AND m.parsed_r2_key IS NOT NULL AND m.deletion_pending = 0`,
    )
    .first<{ n: number }>();
  return { processed: statements.length, remaining: Number(left?.n ?? 0) };
}
