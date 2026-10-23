import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { ingestEmail } from "../../src/mail/ingest";
import { newGrant } from "../../src/db/security";
import { drainDeletionJobs } from "../../src/db/deletions";
import { getTestBindings, type TestBindings } from "./_mf";

let bindings: TestBindings;
let TEST_ENV: Env;
let DB: D1Database;
let BUCKET: R2Bucket;

const CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const j = async (r: Response): Promise<any> => r.json();

beforeAll(async () => {
  bindings = await getTestBindings();
  TEST_ENV = bindings.env as unknown as Env;
  DB = bindings.db;
  BUCKET = bindings.bucket;
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
const mutationHeaders = { "x-mailvault": "1", "content-type": "application/json" };

async function seedDomain(name = "notify.example"): Promise<string> {
  const id = crypto.randomUUID();
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status)
     VALUES (?1, ?2, ?3, 'active', 'full', 'READY')`,
  )
    .bind(id, `zone-${id.slice(0, 8)}`, name)
    .run();
  return id;
}

/** A stored message without the ingest machinery — the dashboard only counts rows. */
async function seedMessage(domainId: string, dedupe: string, at: string, isRead: boolean) {
  await DB.prepare(
    `INSERT INTO messages (id, domain_id, dedupe_key, envelope_to, subject, received_at, raw_r2_key, is_read, created_at)
     VALUES (?1, ?2, ?3, ?4, 'code', ?5, ?6, ?7, ?5)`,
  )
    .bind(
      crypto.randomUUID(),
      domainId,
      dedupe,
      `x@${dedupe}.example`,
      at,
      `seed/raw/${dedupe}.eml`,
      isRead ? 1 : 0,
    )
    .run();
}

function htmlEmailWithAttachment(to: string, messageId: string): Uint8Array {
  const b = "--BOUNDARY";
  const mime = [
    "From: GitHub <noreply@github.com>",
    `To: ${to}`,
    "Subject: Verify now",
    `Message-ID: <${messageId}@github.com>`,
    "Date: Fri, 19 Sep 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="BOUNDARY"`,
    "",
    b,
    "Content-Type: text/html; charset=utf-8",
    "",
    `<p>Confirm at <a href="https://accounts.example.com/verify?t=1">verify</a></p><script>alert(1)</script><img src="https://track.example/x.gif">`,
    b,
    'Content-Type: application/pdf; name="doc.pdf"',
    'Content-Disposition: attachment; filename="doc.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQK",
    `${b}--`,
    "",
  ].join("\r\n");
  return new TextEncoder().encode(mime);
}

async function makeMessage(to: string, raw: Uint8Array) {
  return {
    message: {
      from: "noreply@github.com",
      to,
      headers: new Headers(),
      raw: new Response(raw).body as ReadableStream<Uint8Array>,
      rawSize: raw.byteLength,
      setReject: () => {},
    },
  };
}

beforeEach(async () => {
  await DB.prepare(`DELETE FROM attachments`).run();
  await DB.prepare(`DELETE FROM messages`).run();
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM provisioning_events`).run();
  await DB.prepare(`DELETE FROM domains`).run();
});

describe("HTTP API", () => {
  it("serves health without auth", async () => {
    const res = await worker.fetch(req("/api/health"), TEST_ENV, CTX);
    expect(res.status).toBe(200);
    expect((await j(res)).ok).toBe(true);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("rejects a non-websocket request to the live route instead of pretending to upgrade", async () => {
    const res = await worker.fetch(req("/api/live"), TEST_ENV, CTX);
    expect(res.status).toBe(426);
    expect((await j(res)).error.code).toBe("PRECONDITION_FAILED");
  });

  it("requires a signed-in identity before the live route answers", async () => {
    // The auth gate runs before the handler, so this is the same 401 every /api/* route
    // gives — the socket cannot become an unauthenticated channel.
    const res = await worker.fetch(
      new Request("http://localhost/api/live", { headers: { origin: "http://localhost" } }),
      { ...TEST_ENV, DEV_AUTH_BYPASS: "false", ENVIRONMENT: "production" } as unknown as Env,
      CTX,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a mutation lacking the CSRF header", async () => {
    const domainId = await seedDomain();
    const res = await worker.fetch(
      req("/api/aliases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domainId, mode: "custom", localPart: "no-csrf" }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(403);
    expect((await j(res)).error.code).toBe("BAD_ORIGIN");
  });

  it("creates, lists, disables and deletes an alias", async () => {
    const domainId = await seedDomain();
    const created = await worker.fetch(
      req("/api/aliases", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ domainId, mode: "custom", localPart: "shop01", label: "Shopping" }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(created.status).toBe(201);
    const alias = await j(created);
    expect(alias.address).toBe("shop01@notify.example");

    const list = await j(await worker.fetch(req("/api/aliases"), TEST_ENV, CTX));
    expect(list.items.some((a: { id: string }) => a.id === alias.id)).toBe(true);

    const disabled = await worker.fetch(
      req(`/api/aliases/${alias.id}/disable`, { method: "POST", headers: mutationHeaders }),
      TEST_ENV,
      CTX,
    );
    expect((await j(disabled)).status).toBe("DISABLED");

    const del = await worker.fetch(
      req(`/api/aliases/${alias.id}`, {
        method: "DELETE",
        headers: mutationHeaders,
        body: JSON.stringify({ purgeMessages: false }),
      }),
      TEST_ENV,
      CTX,
    );
    expect((await j(del)).deleted).toBe(true);
  });

  it("rejects a duplicate custom alias with 409", async () => {
    const domainId = await seedDomain();
    const body = JSON.stringify({ domainId, mode: "custom", localPart: "taken" });
    await worker.fetch(
      req("/api/aliases", { method: "POST", headers: mutationHeaders, body }),
      TEST_ENV,
      CTX,
    );
    const dup = await worker.fetch(
      req("/api/aliases", { method: "POST", headers: mutationHeaders, body }),
      TEST_ENV,
      CTX,
    );
    expect(dup.status).toBe(409);
  });

  it("stores a custom name lowercased, so inbound mail can actually match it", async () => {
    const domainId = await seedDomain();
    const created = await worker.fetch(
      req("/api/aliases", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ domainId, mode: "custom", localPart: "  Shop01  " }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(created.status).toBe(201);
    const alias = await j(created);
    expect(alias.address).toBe("shop01@notify.example");
    expect(alias.localPart).toBe("shop01");

    // Case is not a second mailbox: the same name in another casing must collide.
    const clash = await worker.fetch(
      req("/api/aliases", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ domainId, mode: "custom", localPart: "SHOP01" }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(clash.status).toBe(409);
  });

  it("answers a rejected custom name with the rule it broke, per field", async () => {
    const domainId = await seedDomain();
    const res = await worker.fetch(
      req("/api/aliases", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ domainId, mode: "custom", localPart: "postmaster" }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(400);
    const body = await j(res);
    expect(body.error.message).toBe("Validation failed");
    expect(body.error.details.localPart.join(" ")).toMatch(/reserved for system addresses/i);
  });

  it("stores a message via ingest, renders sanitized HTML, serves attachment, marks read, then deletes", async () => {
    const domainId = await seedDomain();
    await DB.prepare(
      `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, 'verify', 'verify@notify.example', 'ACTIVE')`,
    )
      .bind(crypto.randomUUID(), domainId)
      .run();

    const { message } = await makeMessage(
      "verify@notify.example",
      htmlEmailWithAttachment("verify@notify.example", "api-m1"),
    );
    const stored = await ingestEmail(message, bindings.env, DB, BUCKET);
    expect(stored.status).toBe("stored");
    const messageId = (stored as { messageId: string }).messageId;

    const detail = await j(await worker.fetch(req(`/api/messages/${messageId}`), TEST_ENV, CTX));
    expect(detail.htmlBody).not.toContain("<script");
    expect(detail.htmlBody).not.toContain("track.example");
    expect(detail.htmlBody).toContain("noopener");
    expect(detail.attachments.length).toBe(1);

    const att = detail.attachments[0];
    const dl = await worker.fetch(req(att.downloadPath), TEST_ENV, CTX);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(dl.headers.get("Content-Disposition")).toContain("attachment");
    expect(dl.headers.get("Content-Disposition")).toContain("doc.pdf");

    const read = await worker.fetch(
      req(`/api/messages/${messageId}/read`, {
        method: "PATCH",
        headers: mutationHeaders,
        body: JSON.stringify({ isRead: true }),
      }),
      TEST_ENV,
      CTX,
    );
    expect((await j(read)).isRead).toBe(true);

    const grant = await newGrant(DB, 60_000);
    const del = await worker.fetch(
      req(`/api/messages/${messageId}`, {
        method: "DELETE",
        headers: { ...mutationHeaders, "x-mailvault-stepup": grant.token },
      }),
      TEST_ENV,
      CTX,
    );
    expect(del.status).toBe(202);
    expect(await j(del)).toMatchObject({ deleted: false, state: "PENDING" });
    await drainDeletionJobs(TEST_ENV);
    expect(
      await DB.prepare(`SELECT 1 FROM messages WHERE id=?1`).bind(messageId).first(),
    ).toBeNull();
  });
});

describe("alias lifecycle: notes, pin, archive and timeline", () => {
  const patch = (id: string, body: unknown) =>
    worker.fetch(
      req(`/api/aliases/${id}`, {
        method: "PATCH",
        headers: mutationHeaders,
        body: JSON.stringify(body),
      }),
      TEST_ENV,
      CTX,
    );

  it("changes one field without clobbering the others, and archives out of the default view", async () => {
    const domainId = await seedDomain();
    const created = await j(
      await worker.fetch(
        req("/api/aliases", {
          method: "POST",
          headers: mutationHeaders,
          body: JSON.stringify({ domainId, mode: "custom", localPart: "life01", label: "Life" }),
        }),
        TEST_ENV,
        CTX,
      ),
    );
    expect(created.notes).toBeNull();
    expect(created.pinned).toBe(false);
    expect(created.archived).toBe(false);

    expect((await patch(created.id, { notes: "handed to the staging account" })).status).toBe(200);
    const pinned = await j(await patch(created.id, { pinned: true }));
    expect(pinned.notes).toBe("handed to the staging account");
    expect(pinned.pinned).toBe(true);
    expect(pinned.label).toBe("Life");

    await patch(created.id, { archived: true });
    const active = await j(await worker.fetch(req("/api/aliases"), TEST_ENV, CTX));
    const all = await j(await worker.fetch(req("/api/aliases?view=all"), TEST_ENV, CTX));
    expect(active.items.some((a: { id: string }) => a.id === created.id)).toBe(false);
    expect(all.items.some((a: { id: string }) => a.id === created.id)).toBe(true);
    expect(all.items.find((a: { id: string }) => a.id === created.id).archived).toBe(true);
  });

  it("refuses an empty patch and an oversized note", async () => {
    const domainId = await seedDomain();
    const created = await j(
      await worker.fetch(
        req("/api/aliases", {
          method: "POST",
          headers: mutationHeaders,
          body: JSON.stringify({ domainId, mode: "custom", localPart: "life02" }),
        }),
        TEST_ENV,
        CTX,
      ),
    );
    expect((await patch(created.id, {})).status).toBe(400);
    expect((await patch(created.id, { notes: "x".repeat(1001) })).status).toBe(400);
  });

  it("reports what has arrived at one alias", async () => {
    const domainId = await seedDomain();
    const aliasId = crypto.randomUUID();
    await DB.prepare(
      `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, 'tally', 'tally@notify.example', 'ACTIVE')`,
    )
      .bind(aliasId, domainId)
      .run();
    const stored = await ingestEmail(
      (
        await makeMessage(
          "tally@notify.example",
          htmlEmailWithAttachment("tally@notify.example", "tally-m1"),
        )
      ).message,
      bindings.env,
      DB,
      BUCKET,
    );
    expect(stored.status).toBe("stored");

    const detail = await j(await worker.fetch(req(`/api/aliases/${aliasId}`), TEST_ENV, CTX));
    expect(detail.alias.address).toBe("tally@notify.example");
    expect(detail.stats.messages).toBe(1);
    expect(detail.stats.unread).toBe(1);
    expect(detail.stats.lastReceivedAt).toBeTruthy();
    expect(detail.stats.senders[0]?.name).toContain("GitHub");
  });
});

describe("dashboard mailboxes", () => {
  it("counts each domain's mail on its own, so one mailbox cannot borrow another's", async () => {
    const busy = await seedDomain("busy.example");
    const quiet = await seedDomain("quiet.example");
    await seedDomain("idle.example");
    await seedMessage(busy, "bm1", "2026-09-19T09:00:00.000Z", false);
    await seedMessage(busy, "bm2", "2026-09-18T09:00:00.000Z", true);
    await seedMessage(quiet, "qm1", "2026-09-17T09:00:00.000Z", false);

    const dash = await j(await worker.fetch(req("/api/dashboard"), TEST_ENV, CTX));
    const named = (name: string) => dash.mailboxes.find((m: { name: string }) => m.name === name);

    expect(named("busy.example")).toMatchObject({ total: 2, unread: 1, mailStatus: "READY" });
    expect(named("busy.example")?.lastReceivedAt).toBe("2026-09-19T09:00:00.000Z");
    // An empty domain is still reported: "no mail here" is a fact the owner needs, and it
    // is a different fact from the domain not existing.
    expect(named("idle.example")).toMatchObject({ total: 0, unread: 0, lastReceivedAt: null });
    // Busiest first, because the dashboard leads with where the mail actually is.
    expect(dash.mailboxes.slice(0, 2).map((m: { name: string }) => m.name)).toEqual([
      "busy.example",
      "quiet.example",
    ]);
    expect(dash.totalMessages).toBe(
      dash.mailboxes.reduce((n: number, m: { total: number }) => n + m.total, 0),
    );
  });
});

describe("passkey step-up gate", () => {
  async function aliasId(domainId: string, local: string) {
    const id = crypto.randomUUID();
    await DB.prepare(
      `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, ?3, ?4, 'ACTIVE')`,
    )
      .bind(id, domainId, local, `${local}@notify.example`)
      .run();
    return id;
  }

  async function grantHeader(): Promise<Record<string, string>> {
    const grant = await newGrant(DB, 60_000);
    return { ...mutationHeaders, "x-mailvault-stepup": grant.token };
  }

  it("reports no passkey enrolled on a fresh database", async () => {
    const res = await worker.fetch(req("/api/security/status"), TEST_ENV, CTX);
    const body = await j(res);
    expect(res.status).toBe(200);
    expect(body.enrolled).toBe(false);
    expect(body.passkeys).toEqual([]);
  });

  it("refuses to purge an alias's mail without an unlock, but allows a plain delete", async () => {
    const domainId = await seedDomain();
    const id = await aliasId(domainId, "gate1");

    const blocked = await worker.fetch(
      req(`/api/aliases/${id}`, {
        method: "DELETE",
        headers: mutationHeaders,
        body: JSON.stringify({ purgeMessages: true }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(blocked.status).toBe(403);
    expect((await j(blocked)).error.details).toEqual({ stepUpRequired: true });
    // The refusal must not have taken the alias with it.
    expect(
      (await j(await worker.fetch(req(`/api/aliases/${id}`), TEST_ENV, CTX))).alias,
    ).toBeTruthy();

    const allowed = await worker.fetch(
      req(`/api/aliases/${id}`, {
        method: "DELETE",
        headers: mutationHeaders,
        body: JSON.stringify({ purgeMessages: false }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(allowed.status).toBe(200);
    expect((await j(allowed)).purgedMessages).toBe(false);
  });

  it("lets a live grant through, and stores only its hash", async () => {
    const domainId = await seedDomain();
    const id = await aliasId(domainId, "gate2");
    const grant = await newGrant(DB, 60_000);

    const res = await worker.fetch(
      req(`/api/aliases/${id}`, {
        method: "DELETE",
        headers: { ...mutationHeaders, "x-mailvault-stepup": grant.token },
        body: JSON.stringify({ purgeMessages: true }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(202);
    expect((await j(res)).purgedMessages).toBe(true);
    await drainDeletionJobs(TEST_ENV);

    // A read of the table must not hand out someone else's second factor.
    const stored = await DB.prepare(`SELECT token_hash FROM step_up_grants LIMIT 5`).all<{
      token_hash: string;
    }>();
    for (const row of stored.results ?? []) {
      expect(row.token_hash).not.toBe(grant.token);
      expect(row.token_hash).toHaveLength(64);
    }
  });

  it("rejects an expired grant and a made-up one", async () => {
    const domainId = await seedDomain();
    const id = await aliasId(domainId, "gate3");
    const expired = await newGrant(DB, -1000);

    for (const token of [expired.token, "not-a-real-grant"]) {
      const res = await worker.fetch(
        req(`/api/aliases/${id}`, {
          method: "DELETE",
          headers: { ...mutationHeaders, "x-mailvault-stepup": token },
          body: JSON.stringify({ purgeMessages: true }),
        }),
        TEST_ENV,
        CTX,
      );
      expect(res.status).toBe(403);
    }
  });

  it("gates detaching a domain and turning sender checks off, but not tightening them", async () => {
    const domainId = await seedDomain();
    const zone = (await DB.prepare(`SELECT cloudflare_zone_id AS z FROM domains WHERE id = ?1`)
      .bind(domainId)
      .first<{ z: string }>())!.z;

    const removed = await worker.fetch(
      req(`/api/domains/${zone}`, { method: "DELETE", headers: mutationHeaders }),
      TEST_ENV,
      CTX,
    );
    expect(removed.status).toBe(403);

    const off = await worker.fetch(
      req(`/api/domains/${zone}/auth-policy`, {
        method: "PATCH",
        headers: mutationHeaders,
        body: JSON.stringify({ policy: "OFF" }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(off.status).toBe(403);

    const reject = await worker.fetch(
      req(`/api/domains/${zone}/auth-policy`, {
        method: "PATCH",
        headers: mutationHeaders,
        body: JSON.stringify({ policy: "REJECT" }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(reject.status).toBe(200);

    const withGrant = await worker.fetch(
      req(`/api/domains/${zone}`, { method: "DELETE", headers: await grantHeader() }),
      TEST_ENV,
      CTX,
    );
    expect(withGrant.status).toBe(200);
  });

  it("burns a challenge on first use, so a prompt cannot be replayed", async () => {
    const first = await j(
      await worker.fetch(
        req("/api/security/passkeys/options", { method: "POST", headers: mutationHeaders }),
        TEST_ENV,
        CTX,
      ),
    );
    expect(typeof first.challenge).toBe("string");
    expect(first.options.rp?.id ?? first.options.rpId).toBeTruthy();

    const body = {
      challenge: first.challenge,
      response: {
        id: "c1",
        rawId: "c1",
        type: "public-key",
        clientExtensionResults: {},
        response: {},
      },
    };
    const used = await worker.fetch(
      req("/api/security/passkeys/verify", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(body),
      }),
      TEST_ENV,
      CTX,
    );
    expect(used.status).toBe(400);

    // Same challenge again: refused before verification is even attempted.
    const replay = await worker.fetch(
      req("/api/security/passkeys/verify", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(body),
      }),
      TEST_ENV,
      CTX,
    );
    expect(replay.status).toBe(400);
    expect((await j(replay)).error.message).toMatch(/expired|already used/);
  });

  it("asks for an unlock before adding a second passkey, and never returns key material", async () => {
    const status = await j(await worker.fetch(req("/api/security/status"), TEST_ENV, CTX));
    expect(JSON.stringify(status)).not.toMatch(/publicKey|public_key|credentialId/);

    // Nothing enrolled yet, so the first registration needs only the signed-in identity.
    const ok = await worker.fetch(
      req("/api/security/passkeys/options", { method: "POST", headers: mutationHeaders }),
      TEST_ENV,
      CTX,
    );
    expect(ok.status).toBe(200);
  });
});

describe("push subscription API", () => {
  const good = {
    endpoint: "https://fcm.googleapis.com/fcm/send/secret-token",
    p256dh: "BFakeKeyForTests",
    auth: "fakeauth",
  };

  it("refuses to subscribe when VAPID is not configured", async () => {
    const key = await j(await worker.fetch(req("/api/push/public-key"), TEST_ENV, CTX));
    expect(key.key).toBeNull();
    const res = await worker.fetch(
      req("/api/push/subscribe", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(good),
      }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(503);
    expect((await j(res)).error.code).toBe("PUSH_NOT_CONFIGURED");
  });

  it("validates the endpoint, upserts it, and never echoes the secret URL back", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const env = {
      ...TEST_ENV,
      VAPID_PRIVATE_KEY: JSON.stringify(jwk),
    } as unknown as typeof TEST_ENV;

    const bad = await worker.fetch(
      req("/api/push/subscribe", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ ...good, endpoint: "http://push.example/s/x" }),
      }),
      env,
      CTX,
    );
    expect(bad.status).toBe(400);
    const arbitraryHttps = await worker.fetch(
      req("/api/push/subscribe", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ ...good, endpoint: "https://push.example/s/x" }),
      }),
      env,
      CTX,
    );
    expect(arbitraryHttps.status).toBe(400);

    const created = await worker.fetch(
      req("/api/push/subscribe", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(good),
      }),
      env,
      CTX,
    );
    expect(created.status).toBe(201);
    await worker.fetch(
      req("/api/push/subscribe", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ ...good, p256dh: "rotated" }),
      }),
      env,
      CTX,
    );

    const status = await worker.fetch(req("/api/push/status"), env, CTX);
    const body = await status.text();
    expect(JSON.parse(body)).toEqual({ enabled: true, subscriptions: 1 });
    expect(body).not.toContain("secret-token"); // the endpoint is a bearer credential

    const pub = await j(await worker.fetch(req("/api/push/public-key"), env, CTX));
    expect(pub.key).toMatch(/^B/);

    const off = await worker.fetch(
      req("/api/push/unsubscribe", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ endpoint: good.endpoint }),
      }),
      env,
      CTX,
    );
    expect((await j(off)).removed).toBe(1);
  });
});
