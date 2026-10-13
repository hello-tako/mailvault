import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { AuthVerdict, type ExtractedCode } from "@mailvault/shared";
import type { Env } from "../../src/env";
import { insertMessage } from "../../src/db/messages";
import worker from "../../src/index";
import { newId, nowIso } from "../../src/lib/util";
import { getTestBindings, type TestBindings } from "./_mf";

/**
 * The customer code portal.
 *
 * A grant is the first thing this app has ever handed to a stranger, so the tests are written
 * as an attacker would read them: what can be asked for, what comes back for a link that is
 * wrong, spent, revoked or expired, and whether anything besides one number and one timestamp
 * ever leaves the process.
 */

let bindings: TestBindings;
let TEST_ENV: Env;
let DB: D1Database;
let domainId = "";
let aliasId = "";
let aliasAddress = "";

const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const H = { "x-mailvault": "1", "content-type": "application/json" };

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, { ...init, headers: { origin: "http://localhost", ...(init.headers ?? {}) } });
}

function code(value: string, confidence: number): ExtractedCode {
  return { value, kind: "numeric", length: value.length, confidence, context: "test" };
}

/** Minutes ago, in the same ISO shape ingest writes. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function seedMessage(input: { codes: ExtractedCode[]; verdict?: AuthVerdict; at?: string; subject?: string }): Promise<void> {
  await insertMessage(DB, {
    domainId,
    aliasId,
    providerMessageId: `pm-${newId()}`,
    dedupeKey: `dk-${newId()}`,
    envelopeFrom: "account@meta.com",
    envelopeTo: aliasAddress,
    headerFrom: "Meta <account@meta.com>",
    headerTo: aliasAddress,
    subject: input.subject ?? "Xác nhận email cho Tài khoản Meta mới",
    preview: "Mã xác nhận của bạn",
    receivedAt: input.at ?? nowIso(),
    rawSize: 1200,
    rawR2Key: `raw/${newId()}`,
    parsedR2Key: null,
    hasAttachments: false,
    attachmentCount: 0,
    codes: input.codes,
    links: [],
    authVerdict: input.verdict ?? AuthVerdict.Trusted,
    auth: null,
  });
}

async function mint(body: Record<string, unknown> = {}): Promise<{ token: string; url: string; grant: { id: string } }> {
  const res = await worker.fetch(req(`/api/aliases/${aliasId}/portal-links`, { method: "POST", headers: H, body: JSON.stringify(body) }), TEST_ENV, CTX);
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; url: string; grant: { id: string } };
}

beforeAll(async () => {
  bindings = await getTestBindings();
  TEST_ENV = bindings.env;
  DB = bindings.db;
});

afterAll(async () => {
  await bindings.dispose();
});

beforeEach(async () => {
  await DB.prepare(`DELETE FROM portal_grants`).run();
  await DB.prepare(`DELETE FROM messages`).run();
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM domains`).run();
  domainId = newId();
  aliasId = newId();
  aliasAddress = `shop-${domainId.slice(0, 8)}@demo.example`;
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status)
     VALUES (?1, ?2, 'demo.example', 'active', 'full', 'READY')`,
  )
    .bind(domainId, `zone-${domainId.slice(0, 8)}`)
    .run();
  await DB.prepare(`INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, ?3, ?4, 'ACTIVE')`)
    .bind(aliasId, domainId, aliasAddress.split("@")[0], aliasAddress)
    .run();
});

describe("minting a link", () => {
  it("returns the token once, and never in a list", async () => {
    const { token, url } = await mint({ ttlMinutes: 30 });
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url).toBe(`http://localhost/c/${token}`);

    const list = await worker.fetch(req(`/api/aliases/${aliasId}/portal-links`), TEST_ENV, CTX);
    const body = await list.json<{ items: Record<string, unknown>[] }>();
    expect(body.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toMatch(/token_hash/);
  });

  it("refuses a life outside the useful range", async () => {
    for (const ttlMinutes of [1, 999999]) {
      const res = await worker.fetch(
        req(`/api/aliases/${aliasId}/portal-links`, { method: "POST", headers: H, body: JSON.stringify({ ttlMinutes }) }),
        TEST_ENV,
        CTX,
      );
      expect(res.status, `ttl ${ttlMinutes}`).toBe(400);
    }
  });
});

describe("the customer page", () => {
  it("serves a page that cannot be cached, indexed or framed into another origin's session", async () => {
    const { token } = await mint();
    const res = await worker.fetch(req(`/c/${token}`), TEST_ENV, CTX);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    // The page is a shell: the number itself only ever comes from the JSON endpoint.
    expect(html).not.toMatch(/\b\d{6}\b/);
  });

  it("shows the code that clears the floor, not the postcode in Meta's footer", async () => {
    await seedMessage({ codes: [code("94025", 0.47), code("428954", 0.65)] });
    const { token } = await mint();
    const res = await worker.fetch(req(`/c/${token}/code`), TEST_ENV, CTX);
    const body = await res.json<{ state: string; code: string; alias: string; ageSeconds: number }>();
    expect(body.state).toBe("code");
    expect(body.code).toBe("428954");
    expect(body.alias).toBe(aliasAddress);
    expect(body.ageSeconds).toBeLessThan(120);
  });

  it("says it is waiting rather than showing a weak number", async () => {
    await seedMessage({ codes: [code("94025", 0.47)] });
    const { token } = await mint();
    const body = await (await worker.fetch(req(`/c/${token}/code`), TEST_ENV, CTX)).json<{ state: string }>();
    expect(body.state).toBe("waiting");
  });

  it("never answers a spoofed message, whatever it claims", async () => {
    await seedMessage({ codes: [code("246810", 0.9)], verdict: AuthVerdict.Spoofed });
    const { token } = await mint();
    const body = await (await worker.fetch(req(`/c/${token}/code`), TEST_ENV, CTX)).json<{ state: string }>();
    expect(body.state).toBe("waiting");
  });

  it("lets a code go stale, because an old one is a wrong one", async () => {
    await seedMessage({ codes: [code("135790", 0.8)], at: ago(45) });
    const { token } = await mint();
    const body = await (await worker.fetch(req(`/c/${token}/code`), TEST_ENV, CTX)).json<{ state: string }>();
    expect(body.state).toBe("waiting");
  });

  it("answers with nothing but a code, its age and the address", async () => {
    await seedMessage({ codes: [code("864213", 0.7)], subject: "SECRET-SUBJECT-DO-NOT-LEAK" });
    const { token } = await mint();
    const res = await worker.fetch(req(`/c/${token}/code`), TEST_ENV, CTX);
    const text = await res.text();
    expect(text).not.toContain("SECRET-SUBJECT-DO-NOT-LEAK");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["ageSeconds", "alias", "code", "kind", "state"]);
  });
});

describe("a link that should not work", () => {
  it("treats a wrong token and a malformed one the same way", async () => {
    await seedMessage({ codes: [code("111111", 0.9)] });
    for (const path of [`/c/${"z".repeat(32)}`, "/c/not-a-token-at-all!"]) {
      const res = await worker.fetch(req(path), TEST_ENV, CTX);
      expect(res.status).toBe(404);
      const json = await (await worker.fetch(req(`${path}/code`), TEST_ENV, CTX)).json<{ state: string }>();
      expect(json.state).toBe("invalid");
    }
  });

  it("says expired for an expired link, and stops serving it", async () => {
    const { token } = await mint({ ttlMinutes: 5 });
    await DB.prepare(`UPDATE portal_grants SET expires_at = ?2 WHERE token_hash = ?1`)
      .bind(await sha256(token), ago(1))
      .run();
    expect((await worker.fetch(req(`/c/${token}`), TEST_ENV, CTX)).status).toBe(410);
    expect((await worker.fetch(req(`/c/${token}/code`), TEST_ENV, CTX)).status).toBe(410);
  });

  it("stops after the number of looks it was given", async () => {
    await seedMessage({ codes: [code("222333", 0.9)] });
    const { token } = await mint({ ttlMinutes: 60, maxViews: 2 });
    expect((await worker.fetch(req(`/c/${token}`), TEST_ENV, CTX)).status).toBe(200);
    // Polling the JSON endpoint is not a second look, or a customer watching the page would
    // spend their own allowance.
    for (let i = 0; i < 5; i++) expect((await worker.fetch(req(`/c/${token}/code`), TEST_ENV, CTX)).status).toBe(200);
    expect((await worker.fetch(req(`/c/${token}`), TEST_ENV, CTX)).status).toBe(200);
    expect((await worker.fetch(req(`/c/${token}/code`), TEST_ENV, CTX)).status).toBe(403);
  });

  it("dies when the owner revokes it", async () => {
    const { token, grant } = await mint();
    await seedMessage({ codes: [code("444555", 0.9)] });
    expect((await worker.fetch(req(`/c/${token}/code`), TEST_ENV, CTX)).status).toBe(200);

    const revoked = await worker.fetch(req(`/api/aliases/${aliasId}/portal-links/${grant.id}`, { method: "DELETE", headers: H }), TEST_ENV, CTX);
    expect(revoked.status).toBe(200);
    expect((await worker.fetch(req(`/c/${token}/code`), TEST_ENV, CTX)).status).toBe(404);
  });

  it("will not revoke another alias's link", async () => {
    const { grant } = await mint();
    const other = newId();
    const res = await worker.fetch(req(`/api/aliases/${other}/portal-links/${grant}`, { method: "DELETE", headers: H }), TEST_ENV, CTX);
    expect(res.status).toBe(404);
  });
});

describe("the portal hostname itself", () => {
  // Built inside the test, not at collection time: `TEST_ENV` is only assigned in `beforeAll`.
  const portalEnv = (): Env => ({ ...TEST_ENV, PORTAL_ORIGIN: "https://code.example" });
  const at = (path: string) => worker.fetch(new Request(`https://code.example${path}`), portalEnv(), CTX);

  it("answers nothing but /c/, so the owner's app never appears on a public domain", async () => {
    const { token } = await mint();
    expect((await at(`/c/${token}`)).status).toBe(200);

    for (const path of ["/", "/inbox", "/api/health", "/api/messages"]) {
      const res = await at(path);
      expect(res.status, path).toBe(404);
      const body = await res.text();
      expect(body, path).not.toContain('id="root"');
      expect(res.headers.get("x-robots-tag"), path).toContain("noindex");
    }
  });

  it("leaves the mailbox host alone", async () => {
    expect((await worker.fetch(req("/api/health"), TEST_ENV, CTX)).status).toBe(200);
  });
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
