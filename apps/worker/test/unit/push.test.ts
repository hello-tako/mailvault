import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { isUsableEndpoint, pushToAll, saveSubscription, vapidPublicKey } from "../../src/push";

async function freshJwk() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  // Independent path to the uncompressed point: import the public half, then export raw —
  // exactly what a browser does with the VAPID key we hand it.
  const pub = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  const raw = await crypto.subtle.exportKey("raw", pub);
  return { jwk, raw: new Uint8Array(raw as ArrayBuffer) };
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("push endpoint validation", () => {
  it("accepts only https endpoints of sane length", () => {
    expect(isUsableEndpoint("https://push.example.com/s/abc123")).toBe(true);
    expect(isUsableEndpoint("http://push.example.com/s/abc")).toBe(false);
    expect(isUsableEndpoint("not a url")).toBe(false);
    expect(isUsableEndpoint("")).toBe(false);
    expect(isUsableEndpoint(`https://x.example/${"y".repeat(2100)}`)).toBe(false);
  });
});

describe("VAPID public key derivation", () => {
  it("produces the uncompressed P-256 point the browser subscribes with", async () => {
    const { jwk, raw } = await freshJwk();
    const derived = vapidPublicKey(jwk);
    expect(derived).toBe(b64url(raw));
    expect(raw[0]).toBe(0x04);
    expect(raw.byteLength).toBe(65);
  });
});

interface FakePushRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
}

function fakePushDb(rows: FakePushRow[]) {
  const writes: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(rawSql: string) {
      const sql = rawSql.replace(/\s+/g, " ").trim();
      let binds: unknown[] = [];
      const api: Record<string, unknown> = {
        bind: (...args: unknown[]) => {
          binds = args;
          return api;
        },
        first: async () => {
          writes.push({ sql, binds });
          if (/RETURNING fails/.test(sql)) return { fails: Number(binds[1] ?? 0) + 5 };
          const endpoint = binds[0];
          const hit = rows.find((r) => r.endpoint === endpoint);
          return hit ? { id: hit.id } : null;
        },
        all: async () => {
          writes.push({ sql, binds });
          return { results: rows.map((r) => ({ ...r })) };
        },
        run: async () => {
          writes.push({ sql, binds });
          if (sql.startsWith("INSERT INTO push_subscriptions")) {
            rows.push({ id: String(binds[0]), endpoint: String(binds[1]), p256dh: String(binds[2]), auth: String(binds[3]), user_agent: null });
          }
          if (/^DELETE FROM push_subscriptions/.test(sql)) {
            const id = binds[0];
            const i = rows.findIndex((r) => r.id === id || r.endpoint === id);
            if (i >= 0) rows.splice(i, 1);
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return api;
    },
    // A batch executes its statements like the real binding does — the parallel sweep
    // writes its updates and deletions through here.
    batch: async (stmts: { run: () => Promise<Record<string, unknown>> }[]) => {
      const out: Record<string, unknown>[] = [];
      for (const stmt of stmts) out.push(await stmt.run());
      return out;
    },
  };
  return { db: db as unknown as D1Database, writes };
}

const VAPID_ENV = { VAPID_SUBJECT: "mailto:owner@example.com", ENVIRONMENT: "test" };

describe("pushToAll is payload-free and self-healing", () => {
  it("does nothing when VAPID is not configured", async () => {
    const { db } = fakePushDb([]);
    const outcome = await pushToAll({} as Env, db, fetch);
    expect(outcome).toEqual({ sent: 0, pruned: 0, failed: 0, skipped: "not-configured" });
  });

  it("sends an empty body with a VAPID Authorization header, and prunes a retracted subscription", async () => {
    const { jwk } = await freshJwk();
    const env = { ...VAPID_ENV, VAPID_PRIVATE_KEY: JSON.stringify(jwk) } as unknown as Env;
    const rows: FakePushRow[] = [
      { id: "p1", endpoint: "https://push.one/s/alive", p256dh: "KEY", auth: "AUTH", user_agent: null },
      { id: "p2", endpoint: "https://push.two/s/dead", p256dh: "KEY", auth: "AUTH", user_agent: null },
    ];
    const { db } = fakePushDb(rows);
    const calls: { url: string; init: RequestInit }[] = [];

    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: String(url).includes("dead") ? 410 : 201 });
    }) as unknown as typeof fetch;

    const outcome = await pushToAll(env, db, fakeFetch);

    expect(outcome.sent).toBe(1);
    expect(outcome.pruned).toBe(1);
    expect(rows.map((r) => r.id)).toEqual(["p1"]);
    for (const call of calls) {
      expect(call.init.method).toBe("POST");
      expect(call.init.body ?? null).toBeNull(); // no content leaves the server
      const auth = (call.init.headers as Record<string, string>).Authorization;
      expect(auth).toMatch(/^vapid t=[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\./);
      expect(auth).toContain(`k=${vapidPublicKey(jwk)}`);
      expect((call.init.headers as Record<string, string>).TTL).toBe("3600");
      // An urgency hint below `normal` invites the push service to batch, which turned
      // "new mail" into "mail that arrived two minutes ago".
      expect(Object.keys(call.init.headers as Record<string, string>)).not.toContain("Urgency");
    }
  });

  it("upserts a re-subscribed endpoint instead of duplicating it", async () => {
    const { db, writes } = fakePushDb([]);
    const input = { endpoint: "https://push.example/s/x", p256dh: "A", auth: "B", userAgent: "ua" };
    const first = await saveSubscription(db, input);
    const second = await saveSubscription(db, { ...input, p256dh: "C" });
    expect(second).toBe(first);
    expect(writes.some((w) => /^UPDATE push_subscriptions SET p256dh/.test(w.sql))).toBe(true);
    expect(writes.some((w) => /^INSERT INTO push_subscriptions/.test(w.sql))).toBe(true);
  });
});
