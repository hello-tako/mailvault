import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--remote" && !arg.startsWith("--config="))) {
  console.error("Usage: node scripts/check-schema.mjs [--remote] [--config=wrangler.dev.jsonc]");
  process.exit(2);
}
const remote = args.includes("--remote");
const config =
  args.find((arg) => arg.startsWith("--config="))?.slice(9) ??
  (remote ? "wrangler.jsonc" : "wrangler.dev.jsonc");
const expected = readdirSync(new URL("../migrations/", import.meta.url))
  .filter((name) => /^\d.*\.sql$/.test(name))
  .sort();
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "mail-vault-db",
    remote ? "--remote" : "--local",
    "--config",
    config,
    "--command",
    "SELECT name FROM d1_migrations ORDER BY name",
    "--json",
  ],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  },
);
if (result.status !== 0) {
  console.error("SCHEMA_GATE_BLOCKED: cannot read migration ledger; no deployment is safe.");
  process.exit(1);
}
let batches;
try {
  batches = JSON.parse(result.stdout);
} catch {
  console.error("SCHEMA_GATE_BLOCKED: invalid migration receipt.");
  process.exit(1);
}
if (
  !Array.isArray(batches) ||
  batches.length === 0 ||
  batches.some(
    (batch) =>
      !batch ||
      batch.success !== true ||
      !Array.isArray(batch.results) ||
      batch.results.some((row) => !row || typeof row.name !== "string" || !row.name),
  )
) {
  console.error("SCHEMA_GATE_BLOCKED: incomplete migration receipt.");
  process.exit(1);
}
const names = batches.flatMap((batch) => batch.results.map((row) => row.name));
const applied = new Set(names);
const unexpected = names.filter((name) => !expected.includes(name));
if (unexpected.length || applied.size !== names.length) {
  console.error(
    `SCHEMA_GATE_BLOCKED: unexpected or duplicate migrations: ${unexpected.join(", ")}`,
  );
  process.exit(1);
}
const missing = expected.filter((name) => !applied.has(name));
if (missing.length) {
  console.error(`SCHEMA_GATE_BLOCKED: unapplied migrations: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(
  JSON.stringify({
    event: "schema_gate_passed",
    mode: remote ? "remote-read-only" : "local-read-only",
    migrations: expected.length,
  }),
);
