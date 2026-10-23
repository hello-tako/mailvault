import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { SendingStatus } from "@mailvault/shared";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { newId, nowIso } from "../../src/lib/util";
import { getTestBindings, type TestBindings } from "./_mf";
import { verifiedDkimPassFixture } from "./_auth-fixtures";

/**
 * Sending through a subdomain of the same zone.
 *
 * Cloudflare onboards Email Sending per name inside a zone, and the app now lets a domain pick
 * one — so the two things worth proving are that the choice is only a choice (no DNS, no
 * receiving change) and that a message written against the alias actually leaves under the
 * chosen name with its answers pointed back at the alias.
 */

let bindings: TestBindings;
let TEST_ENV: Env;
let DB: D1Database;
let BUCKET: R2Bucket;

const CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const j = async (r: Response): Promise<any> => r.json();
const H = { "x-mailvault": "1", "content-type": "application/json" };

let sent: any[] = [];

/** A stub binding that records what it was asked to send, like the real one would deliver. */
function acceptingStub(): SendEmail {
  return {
    send: async (message: unknown) => {
      sent.push(message);
      return { messageId: `<wire-${sent.length}@send.example>` };
    },
  } as unknown as SendEmail;
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      origin: "http://localhost",
      "Idempotency-Key": crypto.randomUUID(),
      ...(init.headers ?? {}),
    },
  });
}

let domainId = "";
let zoneId = "";
let aliasAddress = "";

async function seed(overrides: { sending?: string; via?: string | null } = {}) {
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM domains`).run();
  domainId = newId();
  zoneId = `zone-${domainId.slice(0, 8)}`;
  const local = `shop-${domainId.slice(0, 8)}`;
  aliasAddress = `${local}@omnipos.tech`;
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status, sending_status, sending_via)
     VALUES (?1, ?2, 'omnipos.tech', 'active', 'full', 'READY', ?3, ?4)`,
  )
    .bind(domainId, zoneId, overrides.sending ?? SendingStatus.Enabled, overrides.via ?? null)
    .run();
  await DB.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, ?3, ?4, 'ACTIVE')`,
  )
    .bind(newId(), domainId, local, aliasAddress)
    .run();
}

async function row(id: string) {
  return DB.prepare(`SELECT * FROM messages WHERE id = ?1`).bind(id).first<any>();
}

async function domainRow() {
  return DB.prepare(`SELECT * FROM domains WHERE id = ?1`).bind(domainId).first<any>();
}

async function compose(payload: Record<string, unknown> = {}) {
  const res = await worker.fetch(
    req("/api/outbox", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        fromAddress: aliasAddress,
        to: ["buyer@customer.example"],
        subject: "Chốt đơn",
        text: "Cảm ơn bạn!",
        ...payload,
      }),
    }),
    TEST_ENV,
    CTX,
  );
  return { res, body: await j(res) };
}

beforeAll(async () => {
  bindings = await getTestBindings();
  TEST_ENV = bindings.env as unknown as Env;
  DB = bindings.db;
  BUCKET = bindings.bucket;
});

afterAll(async () => {
  delete TEST_ENV.EMAIL;
  await bindings?.dispose();
});

beforeEach(async () => {
  sent = [];
  TEST_ENV.EMAIL = acceptingStub();
  await DB.prepare(`DELETE FROM outbound_jobs`).run();
  await DB.prepare(`DELETE FROM messages`).run();
  await DB.prepare(`DELETE FROM messages_fts`).run();
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM domains`).run();
});

describe("choosing the name a domain sends under", () => {
  it("records the choice and forgets what was believed about the old name", async () => {
    await seed({ sending: SendingStatus.Enabled });
    const res = await worker.fetch(
      req(`/api/domains/${zoneId}/sending-via`, {
        method: "PUT",
        headers: H,
        body: JSON.stringify({ name: "send.omnipos.tech" }),
      }),
      TEST_ENV,
      CTX,
    );
    // No Cloudflare token here, so the state cannot be read — and the choice still stands.
    expect(res.status).toBe(200);
    expect(await j(res)).toMatchObject({
      domainId,
      sendingVia: "send.omnipos.tech",
      sendingStatus: "UNKNOWN",
    });
    const stored = await domainRow();
    expect(stored.sending_via).toBe("send.omnipos.tech");
    // The ENABLED verdict belonged to `omnipos.tech`. Carrying it over would promise a send
    // through a name nobody has checked.
    expect(stored.sending_status).toBe(SendingStatus.Unknown);
    expect(stored.sending_tag).toBeNull();
  });

  it("refuses a name that is not inside the domain's own zone", async () => {
    await seed();
    const res = await worker.fetch(
      req(`/api/domains/${zoneId}/sending-via`, {
        method: "PUT",
        headers: H,
        body: JSON.stringify({ name: "send.otherzone.test" }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(400);
    expect((await domainRow()).sending_via).toBeNull();
  });

  it("treats the domain's own name as no choice at all", async () => {
    await seed({ via: "send.omnipos.tech" });
    const res = await worker.fetch(
      req(`/api/domains/${zoneId}/sending-via`, {
        method: "PUT",
        headers: H,
        body: JSON.stringify({ name: "OMNIPOS.TECH" }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(200);
    expect((await j(res)).sendingVia).toBeNull();
    expect((await domainRow()).sending_via).toBeNull();
  });

  it("clears the choice again", async () => {
    await seed({ via: "send.omnipos.tech" });
    const res = await worker.fetch(
      req(`/api/domains/${zoneId}/sending-via`, {
        method: "PUT",
        headers: H,
        body: JSON.stringify({ name: null }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(200);
    expect((await domainRow()).sending_via).toBeNull();
  });
});

describe("sending as the chosen name", () => {
  it("leaves under the subdomain and points the answer at the alias", async () => {
    await seed({ via: "send.omnipos.tech" });
    const { res, body } = await compose();
    expect(res.status).toBe(201);

    // The alias's own local part, on the name Cloudflare signed for. Nothing in the request
    // could have chosen either half.
    expect(sent[0].from).toBe(`${aliasAddress.split("@")[0]}@send.omnipos.tech`);
    expect(sent[0].replyTo).toBe(aliasAddress);

    const stored = await row(body.id);
    expect(stored.envelope_from).toBe(sent[0].from);
    expect(stored.reply_to).toBe(aliasAddress);
    // Still the same mailbox: the row belongs to the alias it was written from.
    expect(stored.alias_id).toBe(
      (
        await DB.prepare(`SELECT id FROM aliases WHERE address = ?1`)
          .bind(aliasAddress)
          .first<any>()
      ).id,
    );
    expect(stored.direction).toBe("OUT");

    const raw = await (await BUCKET.get(stored.raw_r2_key))!.text();
    expect(raw).toContain(`From: ${sent[0].from}`);
    expect(raw).toContain(`Reply-To: ${aliasAddress}`);
    // The record is self-identifying under the name that actually sent it.
    expect(raw).toMatch(/Message-ID: <[0-9a-f-]+@send\.omnipos\.tech>/);
  });

  it("keeps a display name and an explicit Reply-To from the caller", async () => {
    await seed({ via: "send.omnipos.tech" });
    const { res } = await compose({ fromName: "Cửa hàng của Tú", replyTo: "support@omnipos.tech" });
    expect(res.status).toBe(201);
    expect(sent[0].from).toEqual({
      email: `${aliasAddress.split("@")[0]}@send.omnipos.tech`,
      name: "Cửa hàng của Tú",
    });
    // The owner asked for answers somewhere specific; the subdomain default steps aside.
    expect(sent[0].replyTo).toBe("support@omnipos.tech");
  });

  it("sends as the domain itself when no name was chosen", async () => {
    await seed();
    const { res } = await compose();
    expect(res.status).toBe(201);
    expect(sent[0].from).toBe(aliasAddress);
    expect(sent[0].replyTo).toBeUndefined();
    const stored = await row((await DB.prepare(`SELECT id FROM messages LIMIT 1`).first<any>()).id);
    expect(stored.reply_to).toBeNull();
  });

  it("refuses while the chosen name is not enabled, and says which domain it checked", async () => {
    await seed({ sending: SendingStatus.Disabled, via: "send.omnipos.tech" });
    const { res, body } = await compose();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("SENDING_DISABLED");
    expect(sent).toHaveLength(0);
  });

  it("answers a received mail through the same name, from the alias it arrived on", async () => {
    await seed({ via: "send.omnipos.tech" });
    const parentId = newId();
    await DB.prepare(
      `INSERT INTO messages (id, domain_id, alias_id, provider_message_id, dedupe_key, envelope_from, envelope_to,
         header_from, header_to, subject, received_at, raw_r2_key, auth_verdict, auth_json, direction, thread_root_id, is_read)
       VALUES (?1, ?2, (SELECT id FROM aliases WHERE address = ?3), ?4, ?5, 'billing@customer.example', ?3,
         'Billing <billing@customer.example>', ?3, 'Your invoice', ?6, ?7, 'TRUSTED', ?8, 'IN', ?1, 1)`,
    )
      .bind(
        parentId,
        domainId,
        aliasAddress,
        `${parentId}@customer.example`,
        `in-${parentId}`,
        nowIso(),
        `seed/${parentId}.eml`,
        verifiedDkimPassFixture("customer.example"),
      )
      .run();

    const res = await worker.fetch(
      req(`/api/messages/${parentId}/reply`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ text: "Đã nhận được." }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(201);
    expect(sent[0].to).toEqual(["billing@customer.example"]);
    expect(sent[0].from).toBe(`${aliasAddress.split("@")[0]}@send.omnipos.tech`);
    expect(sent[0].replyTo).toBe(aliasAddress);
    expect((await row((await j(res)).id)).thread_root_id).toBe(parentId);
  });
});
