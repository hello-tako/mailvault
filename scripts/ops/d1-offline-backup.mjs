import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The offline D1 backup.
 *
 * `wrangler d1 export` refuses any database that contains virtual tables ("cannot export
 * databases with virtual tables (like FTS5)"), and MailVault has had `messages_fts` since
 * migration 0003 — so the export API has never been a path this database could take. This
 * script builds the same plain .sql itself through the ordinary query API, which has no
 * such refusal: schema from sqlite_master (the virtual table's CREATE statement included
 * as text), one INSERT per row of every regular table, then the migration-0003 backfill
 * to repopulate the index on restore. Read-only against the source database.
 *
 * Restore: sqlite3 <fresh.db> < mailvault-<date>.sql  (see DEPLOYMENT.md, "Backups &
 * disaster recovery"). FTS contents are rebuilt by the backfill statement at the end.
 */

const args = process.argv.slice(2);
if (args.some((a) => a !== "--local" && !a.startsWith("--output="))) {
  console.error("Usage: node scripts/ops/d1-offline-backup.mjs --output=<file.sql> [--local]");
  process.exit(2);
}
const local = args.includes("--local");
const output = args.find((a) => a.startsWith("--output="))?.slice(9);
if (!output) {
  console.error("d1-offline-backup: --output=<file.sql> is required");
  process.exit(2);
}

const workerDir = fileURLToPath(new URL("../../apps/worker/", import.meta.url));
const config = local ? "wrangler.dev.jsonc" : "wrangler.jsonc";

/** One D1 query through wrangler, parsed from its --json envelope. */
// GitHub runners have npx but no pnpm; the owner's machine has the repo's pinned pnpm.
const [runner, runnerArgs] = process.env.CI
  ? ["npx", ["--yes", "wrangler@4.136.0"]]
  : ["pnpm", ["exec", "wrangler"]];
function query(sql) {
  const res = spawnSync(
    runner,
    [
      ...runnerArgs, "d1", "execute", "mail-vault-db",
      local ? "--local" : "--remote",
      "--config", config,
      "--command", sql,
      "--json",
    ],
    { cwd: workerDir, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    console.error(res.error ?? res.stdout);
    console.error(res.stderr);
    throw new Error(`D1 query failed: ${sql.slice(0, 80)}…`);
  }
  const batches = JSON.parse(res.stdout);
  const batch = Array.isArray(batches) ? batches[0] : batches;
  if (!batch?.success) throw new Error(`D1 query unsuccessful: ${sql.slice(0, 80)}…`);
  return batch.results ?? [];
}

const sqlLiteral = (v) =>
  v === null || v === undefined
    ? "NULL"
    : typeof v === "number"
      ? String(v)
      : typeof v === "boolean"
        ? (v ? "1" : "0")
        : `'${String(v).replace(/'/g, "''")}'`;

const schema = query(
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type DESC, name",
);
const virtualTables = schema
  .filter((r) => r.type === "table" && /^CREATE VIRTUAL/i.test(r.sql ?? ""))
  .map((r) => r.name);
// Only the fts5 shadow tables (vt_data, vt_idx, …) are skipped; the virtual table's own
// CREATE statement is ordinary SQL text that a restore target runs without complaint.
const isShadow = (name) => virtualTables.some((vt) => name.startsWith(`${vt}_`));
const tables = schema
  .filter((r) => r.type === "table" && !/^CREATE VIRTUAL/i.test(r.sql ?? "") && !isShadow(r.name))
  .map((r) => r.name);
const objects = schema.filter(
  (r) =>
    (r.type === "index" || r.type === "trigger" || r.type === "view") &&
    !isShadow(r.tbl_name) &&
    r.sql, // sqlite_autoindex rows carry no DDL of their own
);

const parts = [
  `-- MailVault offline D1 backup — generated ${new Date().toISOString()} (${local ? "local" : "remote"}).`,
  "-- Schema for every regular table plus the FTS5 virtual table's CREATE statement, then",
  "-- one INSERT per row, then the migration-0003 backfill repopulates messages_fts.",
  "PRAGMA foreign_keys=OFF;",
  "BEGIN TRANSACTION;",
];
for (const row of [...schema.filter((r) => r.type === "table" && !isShadow(r.name)), ...objects]) {
  parts.push(`${row.sql};`);
}
const counts = [];
for (const table of tables) {
  const rows = query(`SELECT * FROM "${table}"`);
  counts.push([table, rows.length]);
  for (const row of rows) {
    parts.push(
      `INSERT INTO "${table}" (${Object.keys(row).map((c) => `"${c}"`).join(", ")}) VALUES (${Object.values(row)
        .map(sqlLiteral)
        .join(", ")});`,
    );
  }
}
if (virtualTables.includes("messages_fts")) {
  parts.push(
    "-- Repopulate the search index from the messages rows imported above (migration 0003's backfill).",
    "INSERT INTO messages_fts (message_id, subject, preview, sender)",
    "SELECT id, COALESCE(subject, ''), COALESCE(preview, ''), COALESCE(header_from, '')",
    "FROM messages WHERE id NOT IN (SELECT message_id FROM messages_fts);",
  );
}
parts.push("COMMIT;", "");
writeFileSync(output, parts.join("\n"), "utf-8");

console.log(`d1-offline-backup: wrote ${output}`);
for (const [table, n] of counts) console.log(`  ${String(n).padStart(7)}  ${table}`);
console.log(`  virtual: ${virtualTables.join(", ") || "none"} (rebuilt on restore)`);
