import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as WebauthnModule from "../../src/lib/webauthn";

vi.mock("../../src/lib/webauthn", async (importOriginal) => {
  const actual = await importOriginal<typeof WebauthnModule>();
  return {
    ...actual,
    verifyRegistration: vi.fn(async () => ({
      ok: true as const,
      credentialId: "attacker-credential",
      publicKey: "test-public-key",
      counter: 0,
      transports: null,
    })),
    verifyAssertion: vi.fn(async () => ({ ok: true as const, newCounter: 1 })),
  };
});

import worker from "../../src/index";
import { verifyAssertion, verifyRegistration } from "../../src/lib/webauthn";
import { semanticEnabled, setSemanticEnabled } from "../../src/lib/semantic";
import { getTestBindings, type TestBindings } from "./_mf";

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const mutationHeaders = { "x-mailvault": "1", "content-type": "application/json" };
let bindings: TestBindings;
let db: D1Database;
let bucket: R2Bucket;
let env: TestBindings["env"];

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { origin: "http://localhost", ...(init.headers ?? {}) },
  });
}

function post(path: string, body: unknown): Promise<Response> {
  return worker.fetch(
    req(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify(body) }),
    env,
    CTX,
  );
}

async function seedMessage(domainId: string, id: string): Promise<string> {
  const rawKey = `raw/${id}.eml`;
  await bucket.put(rawKey, "private message");
  await db
    .prepare(
      `INSERT INTO messages (id, domain_id, dedupe_key, received_at, raw_r2_key)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(id, domainId, id, new Date().toISOString(), rawKey)
    .run();
  return rawKey;
}

async function seedDomain(zoneId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type)
       VALUES (?1, ?2, ?3, 'active', 'full')`,
    )
    .bind(id, zoneId, `${zoneId}.example`)
    .run();
  return id;
}

beforeAll(async () => {
  bindings = await getTestBindings();
  db = bindings.db;
  bucket = bindings.bucket;
  env = bindings.env;
});

afterAll(async () => {
  await bindings?.dispose();
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await db.prepare(`DELETE FROM messages_fts`).run();
  await db.prepare(`DELETE FROM messages`).run();
  await db.prepare(`DELETE FROM aliases`).run();
  await db.prepare(`DELETE FROM domains`).run();
  await db.prepare(`DELETE FROM passkeys`).run();
  await db.prepare(`DELETE FROM webauthn_challenges`).run();
  await db.prepare(`DELETE FROM step_up_grants`).run();
  await db.prepare(`DELETE FROM app_settings`).run();
});

describe("step-up security regressions", () => {
  it("does not let an Access-only session remove the last key, enroll an attacker, and mint a grant", async () => {
    const original = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO passkeys (id, credential_id, public_key, counter, created_at)
         VALUES (?1, 'victim-credential', 'test-public-key', 0, ?2)`,
      )
      .bind(original, new Date().toISOString())
      .run();

    const removed = await worker.fetch(
      req(`/api/security/passkeys/${original}`, { method: "DELETE", headers: mutationHeaders }),
      env,
      CTX,
    );
    let grantMinted = false;
    const flow = [removed.status];

    if (removed.status === 200) {
      const registrationOptions = await post("/api/security/passkeys/options", {});
      flow.push(registrationOptions.status);
      if (registrationOptions.status === 200) {
        const registration = (await registrationOptions.json()) as {
          challenge: string;
          options: { challenge: string };
        };
        expect(registration.options.challenge).toBe(registration.challenge);
        const registered = await post("/api/security/passkeys/verify", {
          challenge: registration.challenge,
          response: {
            id: "attacker-credential",
            rawId: "attacker-credential",
            type: "public-key",
            clientExtensionResults: {},
            response: {},
          },
        });
        flow.push(registered.status);
        if (registered.status === 200) {
          const assertionOptions = await post("/api/security/step-up/options", {});
          flow.push(assertionOptions.status);
          if (assertionOptions.status === 200) {
            const assertion = (await assertionOptions.json()) as {
              challenge: string;
              options: { challenge: string };
            };
            expect(assertion.options.challenge).toBe(assertion.challenge);
            const verified = await post("/api/security/step-up/verify", {
              challenge: assertion.challenge,
              response: {
                id: "attacker-credential",
                rawId: "attacker-credential",
                type: "public-key",
                clientExtensionResults: {},
                response: {},
              },
            });
            flow.push(verified.status);
            if (verified.status === 200) {
              const body = (await verified.json()) as { token: string };
              const row = await db
                .prepare(`SELECT 1 AS ok FROM step_up_grants WHERE token_hash = ?1`)
                .bind(await (await import("../../src/lib/util")).sha256Hex(body.token))
                .first();
              grantMinted = !!row;
            }
          }
        }
      }
    }

    expect({ flow, grantMinted }).toEqual({ flow: [403], grantMinted: false });
  });

  it("requires a grant to remove the last key and revokes grants after the removal", async () => {
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO passkeys (id, credential_id, public_key, counter, created_at)
         VALUES (?1, 'victim-credential', 'test-public-key', 0, ?2)`,
      )
      .bind(id, new Date().toISOString())
      .run();
    const grant = await (await import("../../src/db/security")).newGrant(db, 60_000);
    const otherGrant = await (await import("../../src/db/security")).newGrant(db, 60_000);

    const response = await worker.fetch(
      req(`/api/security/passkeys/${id}`, {
        method: "DELETE",
        headers: { ...mutationHeaders, "x-mailvault-stepup": grant.token },
      }),
      env,
      CTX,
    );
    const remainingKeys = await db
      .prepare(`SELECT COUNT(*) AS count FROM passkeys`)
      .first<{ count: number }>();
    const remainingGrants = await db
      .prepare(`SELECT COUNT(*) AS count FROM step_up_grants`)
      .first<{ count: number }>();

    expect({
      status: response.status,
      keys: Number(remainingKeys?.count),
      grants: Number(remainingGrants?.count),
    }).toEqual({
      status: 200,
      keys: 0,
      grants: 0,
    });
    expect(grant.token).not.toBe(otherGrant.token);
  });

  it("requires a grant before single and bulk permanent message deletion", async () => {
    const domainId = await seedDomain(`messages-${crypto.randomUUID()}`);
    const singleId = crypto.randomUUID();
    const bulkId = crypto.randomUUID();
    const singleRaw = await seedMessage(domainId, singleId);
    const bulkRaw = await seedMessage(domainId, bulkId);

    const single = await worker.fetch(
      req(`/api/messages/${singleId}`, { method: "DELETE", headers: mutationHeaders }),
      env,
      CTX,
    );
    const bulk = await post("/api/messages/bulk", { ids: [bulkId], action: "delete" });
    const stillPresent = await db
      .prepare(`SELECT COUNT(*) AS count FROM messages WHERE id IN (?1, ?2)`)
      .bind(singleId, bulkId)
      .first<{ count: number }>();
    const objects = await Promise.all([bucket.get(singleRaw), bucket.get(bulkRaw)]);

    expect({
      statuses: [single.status, bulk.status],
      stillPresent: Number(stillPresent?.count),
      objectsPresent: objects.filter(Boolean).length,
    }).toEqual({
      statuses: [403, 403],
      stillPresent: 2,
      objectsPresent: 2,
    });
  });

  it("requires a grant before disabling semantic search and purging its index", async () => {
    const mutableEnv = env as unknown as { AI?: unknown; VECTORIZE?: unknown };
    const previous = { AI: mutableEnv.AI, VECTORIZE: mutableEnv.VECTORIZE };
    mutableEnv.AI = { run: async () => ({ data: [] }) };
    mutableEnv.VECTORIZE = { deleteByIds: async () => {} };
    await setSemanticEnabled(db, true);

    try {
      const response = await post("/api/semantic", { enabled: false });
      expect({ status: response.status, stillEnabled: await semanticEnabled(db) }).toEqual({
        status: 403,
        stillEnabled: true,
      });
    } finally {
      mutableEnv.AI = previous.AI;
      mutableEnv.VECTORIZE = previous.VECTORIZE;
    }
  });

  it("re-checks enrollment authorization after passkey options were issued", async () => {
    const options = (await (await post("/api/security/passkeys/options", {})).json()) as {
      challenge: string;
      options: { challenge: string };
    };
    expect(options.options.challenge).toBe(options.challenge);
    await db
      .prepare(
        `INSERT INTO passkeys (id, credential_id, public_key, counter, created_at)
         VALUES (?1, 'existing-credential', 'test-public-key', 0, ?2)`,
      )
      .bind(crypto.randomUUID(), new Date().toISOString())
      .run();

    const response = await post("/api/security/passkeys/verify", {
      challenge: options.challenge,
      response: {
        id: "attacker-credential",
        rawId: "attacker-credential",
        type: "public-key",
        clientExtensionResults: {},
        response: {},
      },
    });
    const rows = await db
      .prepare(`SELECT COUNT(*) AS count FROM passkeys`)
      .first<{ count: number }>();

    expect({ status: response.status, passkeys: Number(rows?.count) }).toEqual({
      status: 403,
      passkeys: 1,
    });
  });

  it("requires the top-level registration challenge, verifies it, and consumes it once", async () => {
    const options = (await (await post("/api/security/passkeys/options", {})).json()) as {
      challenge: string;
    };
    const response = {
      id: "attacker-credential",
      rawId: "attacker-credential",
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: "test-client-data", challenge: "nested-untrusted-value" },
    };
    vi.mocked(verifyRegistration).mockClear();

    const missing = await post("/api/security/passkeys/verify", { response });
    const tampered = await post("/api/security/passkeys/verify", {
      challenge: `${options.challenge}tampered`,
      response,
    });
    expect(missing.status).toBe(400);
    expect(tampered.status).toBe(400);
    expect(vi.mocked(verifyRegistration)).not.toHaveBeenCalled();

    const body = { challenge: options.challenge, response };
    const verified = await post("/api/security/passkeys/verify", body);
    expect(verified.status).toBe(200);
    expect(vi.mocked(verifyRegistration).mock.calls).toHaveLength(1);
    expect(vi.mocked(verifyRegistration).mock.calls[0]?.[1]).toEqual(response);
    expect(vi.mocked(verifyRegistration).mock.calls[0]?.[2]).toBe(options.challenge);

    const grant = await (await import("../../src/db/security")).newGrant(db, 60_000);
    const replay = await worker.fetch(
      req("/api/security/passkeys/verify", {
        method: "POST",
        headers: { ...mutationHeaders, "x-mailvault-stepup": grant.token },
        body: JSON.stringify(body),
      }),
      env,
      CTX,
    );
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: { message: string } }).error.message).toMatch(
      /expired|already used/,
    );
    expect(vi.mocked(verifyRegistration).mock.calls).toHaveLength(1);
  });

  it("requires the top-level assertion challenge, verifies it, and consumes it once", async () => {
    await db
      .prepare(
        `INSERT INTO passkeys (id, credential_id, public_key, counter, created_at)
         VALUES ('assertion-key', 'attacker-credential', 'test-public-key', 0, ?1)`,
      )
      .bind(new Date().toISOString())
      .run();
    const options = (await (await post("/api/security/step-up/options", {})).json()) as {
      challenge: string;
      options: { challenge: string };
    };
    expect(options.options.challenge).toBe(options.challenge);
    const response = {
      id: "attacker-credential",
      rawId: "attacker-credential",
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: "test-client-data", challenge: "nested-untrusted-value" },
    };
    vi.mocked(verifyAssertion).mockClear();

    const missing = await post("/api/security/step-up/verify", { response });
    const tampered = await post("/api/security/step-up/verify", {
      challenge: `${options.challenge}tampered`,
      response,
    });
    expect(missing.status).toBe(400);
    expect(tampered.status).toBe(400);
    expect(vi.mocked(verifyAssertion)).not.toHaveBeenCalled();

    const body = { challenge: options.challenge, response };
    const verified = await post("/api/security/step-up/verify", body);
    expect(verified.status).toBe(200);
    expect(vi.mocked(verifyAssertion).mock.calls).toHaveLength(1);
    expect(vi.mocked(verifyAssertion).mock.calls[0]?.[1]).toEqual(response);
    expect(vi.mocked(verifyAssertion).mock.calls[0]?.[2]).toBe(options.challenge);

    const replay = await post("/api/security/step-up/verify", body);
    expect(replay.status).toBe(400);
    expect(vi.mocked(verifyAssertion).mock.calls).toHaveLength(1);
  });

  it.each([
    {
      name: "foreign MX",
      flag: "allowMxTakeover",
      mx: [
        {
          id: "foreign-mx",
          type: "MX",
          name: "zone.example",
          content: "mx.provider.example",
          priority: 10,
        },
      ],
      catchAll: null,
    },
    {
      name: "foreign catch-all",
      flag: "allowCatchAllTakeover",
      mx: [
        {
          id: "cf-mx",
          type: "MX",
          name: "zone.example",
          content: "route1.mx.cloudflare.net",
          priority: 10,
        },
      ],
      catchAll: { enabled: true, actions: [{ type: "forward", value: ["elsewhere@example.net"] }] },
    },
  ])(
    "does not accept a client takeover flag instead of step-up for $name",
    async ({ flag, mx, catchAll }) => {
      const zoneId = `zone-${crypto.randomUUID()}`;
      await seedDomain(zoneId);
      env.CLOUDFLARE_API_TOKEN = "local-test-token";
      const mutations: string[] = [];

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const method = init?.method ?? "GET";
          if (method !== "GET") mutations.push(`${method} ${url.pathname}`);
          let result: unknown = {};
          if (url.pathname.endsWith("/dns_records")) result = mx;
          else if (url.pathname.endsWith("/email/routing"))
            result = { enabled: true, status: "ready" };
          else if (url.pathname.endsWith("/email/routing/rules/catch_all")) result = catchAll;
          return Response.json({ success: true, result, result_info: { total_pages: 1 } });
        }),
      );

      const response = await post("/api/domains/provision", { zoneIds: [zoneId], [flag]: true });
      const body = (await response.json()) as {
        error?: { details?: { stepUpRequired?: boolean } };
      };
      expect({
        status: response.status,
        stepUpRequired: body.error?.details?.stepUpRequired,
        mutations,
      }).toEqual({
        status: 403,
        stepUpRequired: true,
        mutations: [],
      });
    },
  );

  it("does not prompt on a stale client conflict flag when live preflight is clear", async () => {
    const zoneId = `clear-${crypto.randomUUID()}`;
    await seedDomain(zoneId);
    env.CLOUDFLARE_API_TOKEN = "local-test-token";
    const mutations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? "GET";
        if (method !== "GET") mutations.push(`${method} ${url.pathname}`);
        const result = url.pathname.endsWith("/dns_records")
          ? [
              {
                id: "cf-mx",
                type: "MX",
                name: "zone.example",
                content: "route1.mx.cloudflare.net",
                priority: 10,
              },
            ]
          : url.pathname.endsWith("/email/routing")
            ? { enabled: true, status: "ready" }
            : null;
        return Response.json({ success: true, result, result_info: { total_pages: 1 } });
      }),
    );

    const response = await post("/api/domains/provision", {
      zoneIds: [zoneId],
      allowMxTakeover: true,
      allowCatchAllTakeover: true,
    });
    expect(response.status).toBe(200);
    expect(mutations).toContain(
      "PUT /client/v4/zones/" + zoneId + "/email/routing/rules/catch_all",
    );
    expect(mutations).not.toContain("DELETE /client/v4/zones/" + zoneId + "/dns_records/undefined");
  });

  it("preauthorizes every requested zone before mutating any zone", async () => {
    const clearZone = `clear-${crypto.randomUUID()}`;
    const conflictZone = `conflict-${crypto.randomUUID()}`;
    await seedDomain(clearZone);
    await seedDomain(conflictZone);
    env.CLOUDFLARE_API_TOKEN = "local-test-token";
    const mutations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const parts = url.pathname.split("/");
        const zoneId = parts[4] ?? "";
        const method = init?.method ?? "GET";
        if (method !== "GET") mutations.push(`${method} ${url.pathname}`);
        const result = url.pathname.endsWith("/dns_records")
          ? zoneId === conflictZone
            ? [
                {
                  id: "foreign-mx",
                  type: "MX",
                  name: "zone.example",
                  content: "mx.provider.example",
                  priority: 10,
                },
              ]
            : [
                {
                  id: "cf-mx",
                  type: "MX",
                  name: "zone.example",
                  content: "route1.mx.cloudflare.net",
                  priority: 10,
                },
              ]
          : url.pathname.endsWith("/email/routing")
            ? { enabled: true, status: "ready" }
            : null;
        return Response.json({ success: true, result, result_info: { total_pages: 1 } });
      }),
    );

    const response = await post("/api/domains/provision", {
      zoneIds: [clearZone, conflictZone],
      allowMxTakeover: true,
    });
    const body = (await response.json()) as { error?: { details?: { stepUpRequired?: boolean } } };
    expect({
      status: response.status,
      stepUpRequired: body.error?.details?.stepUpRequired,
      mutations,
    }).toEqual({
      status: 403,
      stepUpRequired: true,
      mutations: [],
    });
  });
});
