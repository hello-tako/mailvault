import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const expected = readdirSync(new URL("../../migrations/", import.meta.url))
  .filter((f) => /^\d.*\.sql$/.test(f))
  .sort();
function run(receipt: unknown, exit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "mailvault-schema-"));
  try {
    mkdirSync(join(dir, "bin"));
    const executable = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(receipt))}); process.exit(${exit});\n`;
    writeFileSync(join(dir, "bin", "pnpm"), executable, { mode: 0o755 });
    return spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../../scripts/check-schema.mjs", import.meta.url))],
      {
        env: { ...process.env, PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}` },
        encoding: "utf8",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
describe("read-only deployment schema gate", () => {
  it("accepts the complete migration ledger", () => {
    expect(run([{ success: true, results: expected.map((name) => ({ name })) }]).status).toBe(0);
  });
  it("blocks a missing lifecycle migration", () => {
    const result = run([
      { success: true, results: expected.slice(0, -1).map((name) => ({ name })) },
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected.at(-1));
  });
  it.each([null, [{ success: false, results: [] }], [{ success: true }]])(
    "blocks malformed receipts %j",
    (receipt) => {
      expect(run(receipt).status).toBe(1);
    },
  );
  it.each([undefined, "true"])("requires an explicit successful receipt (%j)", (success) => {
    const result = run([{ success, results: expected.map((name) => ({ name })) }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SCHEMA_GATE_BLOCKED");
  });
  it("blocks a ledger containing an unknown migration", () => {
    const result = run([
      { success: true, results: [...expected, "9999_unknown.sql"].map((name) => ({ name })) },
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("9999_unknown.sql");
  });
  it.each([null, { name: null }])("blocks malformed ledger rows %j", (row) => {
    const result = run([{ success: true, results: [...expected.map((name) => ({ name })), row] }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SCHEMA_GATE_BLOCKED");
  });
  it("blocks a duplicate migration name", () => {
    const result = run([
      { success: true, results: [...expected, expected[0]].map((name) => ({ name })) },
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SCHEMA_GATE_BLOCKED");
  });
  it("fails closed when the database cannot be read", () => {
    expect(run([], 1).status).toBe(1);
  });
});
