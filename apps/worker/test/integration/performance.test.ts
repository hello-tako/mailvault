import { beforeAll, describe, expect, it } from "vitest";
import { getTestBindings } from "./_mf";

/**
 * Index usage, asserted rather than hoped for. Timing assertions flake on shared CI
 * runners; the query plan is deterministic and says the same thing — "this query seeks
 * into an index instead of reading the whole mailbox".
 *
 * The SQL mirrors the statements `listMessages` and `messageCounters` build (migration
 * 0014 exists for exactly these shapes); if the queries change, these mirrors must
 * change with them, which is why they live in the same repo as a failing test.
 */

const LIST_SQL = `
  SELECT * FROM (
    SELECT m.*, 0 AS rank, a.label AS alias_label, a.address AS alias_address, d.name AS domain_name
    FROM messages m
    LEFT JOIN aliases a ON a.id = m.alias_id
    LEFT JOIN domains d ON d.id = m.domain_id
    WHERE m.direction = 'IN' AND m.archived = 0
  )
  ORDER BY rank ASC, received_at DESC, id DESC
  LIMIT 50`;

const CURSOR_SQL = `
  SELECT * FROM (
    SELECT m.*, 0 AS rank, a.label AS alias_label, a.address AS alias_address, d.name AS domain_name
    FROM messages m
    LEFT JOIN aliases a ON a.id = m.alias_id
    LEFT JOIN domains d ON d.id = m.domain_id
    WHERE m.direction = 'IN' AND m.archived = 0
      AND (m.received_at < ?1 OR (m.received_at = ?1 AND m.id < ?2))
  )
  ORDER BY rank ASC, received_at DESC, id DESC
  LIMIT 50`;

const INBOX_COUNT_SQL = `SELECT COUNT(*) AS c FROM messages WHERE direction = 'IN' AND archived = 0`;

const UNREAD_PER_MAILBOX_SQL = `
  SELECT domain_id, COUNT(*) AS unread FROM messages
  WHERE domain_id = ?1 AND direction = 'IN' AND archived = 0 AND is_read = 0
  GROUP BY domain_id`;

let db: D1Database;

beforeAll(async () => {
  ({ db } = await getTestBindings());
});

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
  return (results ?? []).map((r) => r.detail).join("\n");
}

describe("the working list walks an index, not the mailbox", () => {
  it("seeks the default inbox view through idx_messages_working_list", async () => {
    const detail = await plan(LIST_SQL);
    expect(detail).toContain("idx_messages_working_list");
    expect(detail).not.toMatch(/SCAN m\b/);
  });

  it("answers a cursor page without sorting the whole list", async () => {
    const detail = await plan(CURSOR_SQL, "2026-01-01T00:00:00.000Z", "id");
    expect(detail).toContain("idx_messages_working_list");
    expect(detail).not.toMatch(/SCAN m\b/);
  });
});

describe("the counters endpoint reads indexes, not the mailbox", () => {
  it("a tab count seeks through idx_messages_working_list", async () => {
    const detail = await plan(INBOX_COUNT_SQL);
    expect(detail).toContain("idx_messages_working_list");
    expect(detail).not.toMatch(/SCAN messages\b/);
  });

  it("a mailbox's unread badge seeks through the covering index", async () => {
    // The domain-scoped variant is the shape the covering index exists for: every column
    // of the WHERE and the GROUP BY is in the index, so it is answered without touching
    // the table at all.
    const detail = await plan(UNREAD_PER_MAILBOX_SQL, "d1");
    expect(detail).toContain("idx_messages_counter_cover");
    expect(detail).not.toMatch(/SCAN messages\b/);
  });
});
