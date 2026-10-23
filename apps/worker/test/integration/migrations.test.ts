import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";

const dir = new URL("../../migrations/", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => /^\d.*\.sql$/.test(f))
  .sort();

function statementsFrom(sql: string): string[] {
  const statements: string[] = [];
  let pending = "";
  let inTrigger = false;
  for (const line of sql.split("\n")) {
    if (line.trim().startsWith("--")) continue;
    if (!pending.trim() && /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(line)) {
      inTrigger = true;
    }
    pending += `${line}\n`;
    if (inTrigger) {
      if (/^\s*END\s*;\s*$/.test(line)) {
        statements.push(pending.trim().replace(/;$/, ""));
        pending = "";
        inTrigger = false;
      }
      continue;
    }
    const pieces = pending.split(";");
    pending = pieces.pop() ?? "";
    statements.push(...pieces.map((statement) => statement.trim()).filter(Boolean));
  }
  if (pending.trim()) statements.push(pending.trim());
  return statements.filter((statement) => !/^PRAGMA/i.test(statement));
}

async function apply(db: D1Database, names: string[]) {
  for (const name of names) {
    const statements = statementsFrom(readFileSync(new URL(name, dir), "utf8"));
    await db.batch(statements.map((s) => db.prepare(s)));
  }
}

describe("append-only migration compatibility", () => {
  it.each([false, true])("migrates a %s legacy fixture with valid foreign keys", async (legacy) => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["DB"],
    });
    try {
      const db = (await mf.getD1Database("DB")) as unknown as D1Database;
      if (legacy) {
        await apply(
          db,
          files.filter((f) => f < "0013"),
        );
        await db.batch([
          db.prepare(
            "INSERT INTO domains(id,cloudflare_zone_id,name,zone_status,zone_type) VALUES('d','zone','migration.example','active','full')",
          ),
          db.prepare(
            "INSERT INTO aliases(id,domain_id,local_part,address) VALUES('a','d','owner','owner@migration.example')",
          ),
          db.prepare(
            "INSERT INTO messages(id,domain_id,alias_id,dedupe_key,subject,received_at,raw_r2_key,created_at) VALUES('m','d','a','legacy','fixture','2026-01-01T00:00:00.000Z','raw/fixture','2026-10-07 00:00:00')",
          ),
          db.prepare(
            "INSERT INTO attachments(id,message_id,filename,safe_filename,r2_key) VALUES('att','m','fixture.txt','fixture.txt','attachment/fixture')",
          ),
          db.prepare(
            "INSERT INTO messages_fts(message_id,subject,preview,sender) VALUES('m','fixture','fixture','owner@migration.example')",
          ),
        ]);
        await apply(
          db,
          files.filter((f) => f >= "0013"),
        );
        expect(
          await db.prepare("SELECT raw_r2_key FROM messages WHERE id='m'").first("raw_r2_key"),
        ).toBe("raw/fixture");
        expect(
          await db
            .prepare("SELECT ingest_status FROM messages WHERE id='m'")
            .first("ingest_status"),
        ).toBe("COMMITTED");
        expect(
          await db
            .prepare("SELECT deletion_pending FROM messages WHERE id='m'")
            .first("deletion_pending"),
        ).toBe(0);
        expect(
          await db.prepare("SELECT header_date FROM messages WHERE id='m'").first("header_date"),
        ).toBe("2026-01-01T00:00:00.000Z");
        expect(
          await db.prepare("SELECT received_at FROM messages WHERE id='m'").first("received_at"),
        ).toBe("2026-10-07T00:00:00.000Z");
        expect(
          await db.prepare("SELECT count(*) AS n FROM attachments WHERE message_id='m'").first("n"),
        ).toBe(1);
        expect(
          await db
            .prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'fixture'")
            .first("n"),
        ).toBe(1);
      } else await apply(db, files);
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      for (const table of [
        "deletion_jobs",
        "outbound_jobs",
        "semantic_index_leases",
        "outbound_staging",
        "inbound_staging",
        "inbound_staging_objects",
      ]) {
        expect(
          await db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?1")
            .bind(table)
            .first("name"),
        ).toBe(table);
      }
      // Previous Worker query shapes remain valid on the additive schema, not semantically safe.
      await db
        .prepare(
          "SELECT id, alias_id, raw_r2_key, send_status FROM messages WHERE direction='OUT' ORDER BY received_at DESC LIMIT 50",
        )
        .all();
      await db.prepare("SELECT message_id, address, status FROM message_recipients LIMIT 50").all();
      expect(
        (await db.prepare("PRAGMA index_list(outbound_jobs)").all()).results?.length,
      ).toBeGreaterThan(1);
    } finally {
      await mf.dispose();
    }
  });
});
