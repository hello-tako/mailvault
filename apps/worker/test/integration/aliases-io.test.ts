import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { getTestBindings, type TestBindings } from "./_mf";

/** The address book as a file, and what comes back through one. */
let bindings: TestBindings;
let TEST_ENV: Env;
let DB: D1Database;

const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const MUTATION = { "x-mailvault": "1", "content-type": "application/json" };

beforeAll(async () => {
  bindings = await getTestBindings();
  TEST_ENV = bindings.env as unknown as Env;
  DB = bindings.db;
  const id = crypto.randomUUID();
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status)
     VALUES (?1, ?2, 'io.example', 'active', 'full', 'READY')`,
  )
    .bind(id, `zone-${id.slice(0, 8)}`)
    .run();
  const domain = await DB.prepare(`SELECT id FROM domains WHERE name = 'io.example'`).first<{ id: string }>();
  await DB.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, address, label, notes)
     VALUES (?1, ?2, 'shop', 'shop@io.example', 'Shopping', 'where the spam goes')`,
  )
    .bind(crypto.randomUUID(), domain!.id)
    .run();
});

afterAll(async () => {
  await bindings?.dispose();
});

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { origin: "http://localhost", ...(init.headers ?? {}) },
  });
}

describe("aliases export/import", () => {
  it("export answers with the whole address book as an attachment", async () => {
    const res = await worker.fetch(req("/api/aliases/export"), TEST_ENV, CTX);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("mailvault-aliases-");
    const body = (await res.json()) as { exportedAt: string; aliases: { address: string; label: string | null; notes: string | null }[] };
    const mine = body.aliases.find((a) => a.address === "shop@io.example");
    expect(mine?.label).toBe("Shopping");
    expect(mine?.notes).toBe("where the spam goes");
  });

  it("import adds the missing, skips the present, and names the refused", async () => {
    const res = await worker.fetch(
      req("/api/aliases/import", {
        method: "POST",
        headers: MUTATION,
        body: JSON.stringify({
          aliases: [
            { address: "Imported@IO.example", label: "New one", notes: "from a file" },
            { address: "shop@io.example" },
            { address: "x@nope.example" },
          ],
        }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; skipped: number; invalid: string[] };
    expect(body.created).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.invalid).toEqual(["x@nope.example"]);

    const row = await DB.prepare(`SELECT label, notes FROM aliases WHERE address = 'imported@io.example'`).first<{
      label: string | null;
      notes: string | null;
    }>();
    expect(row?.label).toBe("New one");
    expect(row?.notes).toBe("from a file");
  });

  it("serves a stored message's original bytes as message/rfc822", async () => {
    await bindings.bucket.put("raw/io-test.eml", new TextEncoder().encode("Subject: round trip\r\n\r\nthe original words"));
    const id = crypto.randomUUID();
    const domain = await DB.prepare(`SELECT id FROM domains WHERE name = 'io.example'`).first<{ id: string }>();
    await DB.prepare(
      `INSERT INTO messages (id, domain_id, dedupe_key, envelope_from, envelope_to, subject, received_at, raw_r2_key, raw_size)
       VALUES (?1, ?2, ?3, 'a@b.c', 'shop@io.example', 'round trip', '2026-10-24T00:00:00.000Z', 'raw/io-test.eml', 42)`,
    )
      .bind(id, domain!.id, `io-${id}`)
      .run();

    const res = await worker.fetch(req(`/api/messages/${id}/raw`), TEST_ENV, CTX);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("message/rfc822");
    expect(res.headers.get("content-disposition")).toContain(".eml");
    expect(await res.text()).toContain("the original words");
  });
});
