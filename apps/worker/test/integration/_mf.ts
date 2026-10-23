import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import type { Env } from "../../src/env";
import type { IngestJob } from "../../src/mail/ingest";

/**
 * In-memory stand-in for the queue binding. The harness runs application code in the Node
 * test process, so there is no workerd queue to post to; what matters is that the producer
 * handed over exactly one job per message, and that a consumer can commit it.
 */
export interface CapturedQueue {
  readonly sent: IngestJob[];
  send(message: IngestJob): Promise<void>;
  sendBatch(messages: Array<{ body: IngestJob }>): Promise<void>;
  reset(): void;
}

/**
 * Test harness. The Cloudflare vitest pool cannot boot from a project path that
 * contains spaces (workerd mis-resolves its own vitest shim), so integration tests
 * run under plain Node and talk to real D1 + R2 through a programmatic Miniflare
 * instance instead. Only the storage bindings come from workerd; application code
 * (Hono handlers, postal-mime, jose) executes in the Node test process exactly as it
 * would in the isolate.
 */
export interface TestBindings {
  env: Env;
  db: D1Database;
  bucket: R2Bucket;
  queue: CapturedQueue;
  dispose: () => Promise<void>;
}

let cached: TestBindings | undefined;

/** Applies every migration in filename order, like `wrangler d1 migrations apply`. */
function loadSchema(): string[] {
  const dir = new URL("../../migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => /^\d[\w.-]*\.sql$/.test(f))
    .sort();
  return files.flatMap((file) => {
    const statements: string[] = [];
    let pending = "";
    let inTrigger = false;
    for (const line of readFileSync(new URL(file, dir), "utf8").split("\n")) {
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
  });
}

export async function getTestBindings(): Promise<TestBindings> {
  if (cached) return cached;

  const mf = new Miniflare({
    script: `export default { fetch(){ return new Response("ok"); } }`,
    modules: true,
    compatibilityDate: "2024-12-30",
    d1Databases: { DB: "mail-vault-db-test" },
    r2Buckets: { MAIL_BUCKET: "mail-vault-storage-test" },
  });

  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const bucket = (await mf.getR2Bucket("MAIL_BUCKET")) as unknown as R2Bucket;

  const statements = loadSchema();
  await db.batch(statements.map((sql) => db.prepare(sql)));

  const sent: IngestJob[] = [];
  const queue: CapturedQueue = {
    sent,
    send: async (message) => void sent.push(message),
    sendBatch: async (messages) => void sent.push(...messages.map((m) => m.body)),
    reset: () => void sent.splice(0, sent.length),
  };

  const env = {
    DB: db,
    MAIL_BUCKET: bucket,
    ASSETS: {},
    MAIL_INGEST_QUEUE: queue,
    ENVIRONMENT: "test",
    DEV_AUTH_BYPASS: "true",
    MAX_MESSAGE_BYTES: "20971520",
    MAIL_WORKER_NAME: "mail-vault",
    APP_ORIGIN: "http://localhost",
    CF_ACCOUNT_ID: "test-account",
    CF_ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
    CF_ACCESS_AUD: "test-aud",
    ALLOWED_EMAILS: "",
  } as unknown as Env;

  const created: TestBindings = {
    env,
    db,
    bucket,
    queue,
    dispose: async () => void (await mf.dispose()),
  };
  cached = created;
  return created;
}
