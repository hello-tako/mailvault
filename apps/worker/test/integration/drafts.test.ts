import { beforeAll, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { getTestBindings, type TestBindings } from "./_mf";

let bindings: TestBindings;
let TEST_ENV: Env;
let DB: D1Database;

const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const j = async (r: Response): Promise<any> => r.json();
const H = { "x-mailvault": "1", "content-type": "application/json" };
const req = (path: string, init: RequestInit = {}): Request =>
  new Request(`http://localhost${path}`, {
    ...init,
    headers: { origin: "http://localhost", ...(init.headers ?? {}) },
  });

beforeAll(async () => {
  bindings = await getTestBindings();
  TEST_ENV = bindings.env as unknown as Env;
  DB = bindings.db;
});

describe("server-side drafts (B4)", () => {
  it("saves, updates, lists and deletes a draft by its slot", async () => {
    const put1 = await worker.fetch(
      req("/api/drafts/compose", {
        method: "PUT",
        headers: H,
        body: JSON.stringify({ to: "someone@example.net", subject: "half written", text: "dear " }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(put1.status).toBe(200);

    const put2 = await worker.fetch(
      req("/api/drafts/compose", {
        method: "PUT",
        headers: H,
        body: JSON.stringify({ to: "someone@example.net", subject: "half written", text: "dear sir, " }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(put2.status).toBe(200);
    const saved = await j(put2);
    expect(saved.text).toBe("dear sir, ");
    // One row per slot, not one per autosave.
    const rows = await DB.prepare(`SELECT count(*) AS n FROM drafts`).first<any>();
    expect(rows.n).toBe(1);

    const got = await j(await worker.fetch(req("/api/drafts/compose", { headers: H }), TEST_ENV, CTX));
    expect(got.draft.subject).toBe("half written");

    const listed = await j(await worker.fetch(req("/api/drafts", { headers: H }), TEST_ENV, CTX));
    expect(listed.items).toHaveLength(1);

    const del = await worker.fetch(req("/api/drafts/compose", { method: "DELETE", headers: H }), TEST_ENV, CTX);
    expect((await j(del)).deleted).toBe(true);
    const gone = await j(await worker.fetch(req("/api/drafts/compose", { headers: H }), TEST_ENV, CTX));
    expect(gone.draft).toBeNull();
  });

  it("keeps a reply's draft under its own slot, beside the compose slot", async () => {
    await worker.fetch(
      req("/api/drafts/reply-m1", {
        method: "PUT",
        headers: H,
        body: JSON.stringify({ text: "an answer in progress", replyToMessageId: "m1" }),
      }),
      TEST_ENV,
      CTX,
    );
    await worker.fetch(
      req("/api/drafts/compose", {
        method: "PUT",
        headers: H,
        body: JSON.stringify({ text: "a different letter" }),
      }),
      TEST_ENV,
      CTX,
    );
    const listed = await j(await worker.fetch(req("/api/drafts", { headers: H }), TEST_ENV, CTX));
    expect(listed.items).toHaveLength(2);
    const reply = await j(await worker.fetch(req("/api/drafts/reply-m1", { headers: H }), TEST_ENV, CTX));
    expect(reply.draft.replyToMessageId).toBe("m1");
  });
});

describe("push devices (D4)", () => {
  it("lists a subscription without ever naming its endpoint, labels it, and revokes it", async () => {
    // The integration environment has no VAPID keys (by design — subscribe refuses), so the
    // row is planted the way a real subscription would sit, and only the management
    // endpoints are exercised over HTTP.
    const id = "device-test-1";
    await DB.prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, fails, created_at, updated_at)
       VALUES (?1, 'https://push.example/secret-endpoint-token', 'k', 'a', 'Mozilla/5.0 (iPhone; test)', 0, datetime('now'), datetime('now'))`,
    )
      .bind(id)
      .run();

    const list = await j(await worker.fetch(req("/api/push/devices", { headers: H }), TEST_ENV, CTX));
    const mine = list.items.find((d: any) => d.id === id);
    expect(mine).toBeTruthy();
    // The endpoint is a credential: it must not appear anywhere in the response.
    expect(JSON.stringify(list)).not.toContain("secret-endpoint-token");
    expect(mine.userAgent).toContain("iPhone");

    const labelled = await worker.fetch(
      req(`/api/push/devices/${id}`, { method: "PATCH", headers: H, body: JSON.stringify({ label: "iPhone của tôi" }) }),
      TEST_ENV,
      CTX,
    );
    expect((await j(labelled)).label).toBe("iPhone của tôi");

    const revoked = await worker.fetch(req(`/api/push/devices/${id}`, { method: "DELETE", headers: H }), TEST_ENV, CTX);
    expect((await j(revoked)).removed).toBe(true);
  });
});
