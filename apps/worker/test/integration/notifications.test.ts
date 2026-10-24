import { beforeAll, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { getTestBindings, type TestBindings } from "./_mf";
import {
  deleteNotificationPref,
  isNotificationMuted,
  upsertNotificationPref,
} from "../../src/db/notifications";

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

describe("notification preferences (D1)", () => {
  it("mutes by alias id and by sender domain, and unmutes by row", async () => {
    expect(await isNotificationMuted(DB, { aliasId: "alias-x", envelopeFrom: "no@one.example" })).toBe(false);

    await upsertNotificationPref(DB, { scopeType: "alias", scopeValue: "alias-x" }, "mute");
    expect(await isNotificationMuted(DB, { aliasId: "alias-x", envelopeFrom: "who@anywhere.example" })).toBe(true);
    expect(await isNotificationMuted(DB, { aliasId: "alias-y", envelopeFrom: "who@anywhere.example" })).toBe(false);

    const domain = await upsertNotificationPref(
      DB,
      { scopeType: "sender_domain", scopeValue: "LOUD.example" },
      "mute",
    );
    // Stored lowercase: the switch is about a domain, not about how it was typed.
    expect(domain.scopeValue).toBe("loud.example");
    expect(await isNotificationMuted(DB, { aliasId: "alias-y", envelopeFrom: "who@LOUD.example" })).toBe(true);

    expect(await deleteNotificationPref(DB, domain.id)).toBe(true);
    expect(await isNotificationMuted(DB, { aliasId: "alias-y", envelopeFrom: "who@loud.example" })).toBe(false);
  });

  it("serves the preferences over the API: list, upsert, delete", async () => {
    const put = await worker.fetch(
      req("/api/notifications/prefs", {
        method: "PUT",
        headers: H,
        body: JSON.stringify({ scopeType: "sender_domain", scopeValue: "api.example", action: "mute" }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(put.status).toBe(200);
    const pref = await j(put);
    expect(pref.action).toBe("mute");

    const list = await j(
      await worker.fetch(req("/api/notifications/prefs", { headers: H }), TEST_ENV, CTX),
    );
    expect(list.items.some((p: any) => p.id === pref.id)).toBe(true);

    const del = await worker.fetch(
      req(`/api/notifications/prefs/${pref.id}`, { method: "DELETE", headers: H }),
      TEST_ENV,
      CTX,
    );
    expect(del.status).toBe(200);
    const gone = await worker.fetch(
      req(`/api/notifications/prefs/${pref.id}`, { method: "DELETE", headers: H }),
      TEST_ENV,
      CTX,
    );
    expect(gone.status).toBe(404);
  });
});
