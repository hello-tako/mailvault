import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { ingestEmail } from "../../src/mail/ingest";
import { newId } from "../../src/lib/util";
import { newGrant } from "../../src/db/security";
import { drainDeletionJobs } from "../../src/db/deletions";
import { getTestBindings, type TestBindings } from "./_mf";
import { SendStatus } from "@mailvault/shared";

/*
 * Working over a mailbox rather than reading it: selecting several messages and doing one
 * thing to them, the counts the tabs carry, what a search operator filters to, and what a
 * send looks like once the receiving server has actually answered.
 *
 * The delivery half goes through `worker.queue` rather than calling the consumer directly,
 * because the thing under test is as much the dispatch on queue name as it is the handler:
 * a batch of delivery events handed to the ingest path would otherwise be committed as mail.
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
const ALIAS = "shop-b7@mailbox.example";
const DELIVERY_QUEUE = "mail-delivery-events";

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

const get = (path: string) => worker.fetch(req(path), TEST_ENV, CTX);
const post = (path: string, body: unknown, extraHeaders: Record<string, string> = {}) =>
  worker.fetch(
    req(path, { method: "POST", headers: { ...H, ...extraHeaders }, body: JSON.stringify(body) }),
    TEST_ENV,
    CTX,
  );

/** A queue batch that records what the consumer decided to do with each message. */
function batch(queue: string, bodies: unknown[]) {
  const seen: string[] = [];
  const messages = bodies.map((body) => ({
    body,
    ack: () => void seen.push("ack"),
    retry: () => void seen.push("retry"),
    attempts: 1,
    metadata: {},
  }));
  return {
    batch: { queue, messages } as unknown as MessageBatch<unknown>,
    seen,
  };
}

async function deliver(over: {
  from: string;
  subject: string;
  body: string;
  messageId: string;
  at?: Date;
}) {
  const head = [
    `From: ${over.from}`,
    `To: ${ALIAS}`,
    `Subject: ${over.subject}`,
    `Date: ${(over.at ?? new Date()).toUTCString()}`,
    `Message-ID: <${over.messageId}@${over.from}>`,
    "Content-Type: text/plain; charset=utf-8",
  ].join("\r\n");
  const raw = new TextEncoder().encode(`${head}\r\n\r\n${over.body}\r\n`);
  return ingestEmail(
    {
      from: over.from,
      to: ALIAS,
      headers: new Headers(),
      raw: new Response(raw).body as ReadableStream<Uint8Array>,
      rawSize: raw.byteLength,
      setReject: () => {},
    },
    TEST_ENV,
    DB,
    BUCKET,
  );
}

async function composeTo(to: string[], text = "Hello from the vault.") {
  const res = await post("/api/outbox", { fromAddress: ALIAS, to, subject: "A letter", text });
  expect(res.status).toBe(201);
  return j(res);
}

beforeAll(async () => {
  bindings = await getTestBindings();
  TEST_ENV = bindings.env as unknown as Env;
  DB = bindings.db;
  BUCKET = bindings.bucket;
  TEST_ENV.EMAIL = {
    send: async () => ({ messageId: `<wire-${newId()}@mailbox.example>` }),
  } as unknown as SendEmail;
});

afterAll(async () => {
  await bindings?.dispose();
});

let domainId = "";
beforeEach(async () => {
  await DB.prepare(`DELETE FROM deletion_jobs`).run();
  await DB.prepare(`DELETE FROM message_recipients`).run();
  await DB.prepare(`DELETE FROM outbound_jobs`).run();
  await DB.prepare(`DELETE FROM messages`).run();
  await DB.prepare(`DELETE FROM messages_fts`).run();
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM domains`).run();
  domainId = newId();
  const aliasId = newId();
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status, sending_status)
     VALUES (?1, ?2, 'mailbox.example', 'active', 'full', 'READY', 'ENABLED')`,
  )
    .bind(domainId, `zone-${domainId.slice(0, 8)}`)
    .run();
  await DB.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, 'shop-b7', ?3, 'ACTIVE')`,
  )
    .bind(aliasId, domainId, ALIAS)
    .run();
});

describe("a selection acted on at once", () => {
  async function three() {
    const ids: string[] = [];
    for (const [i, from] of ["a@one.example", "b@two.example", "c@three.example"].entries()) {
      const r = await deliver({
        from,
        subject: `Note ${i}`,
        body: `Body ${i}`,
        messageId: `bulk-${i}`,
      });
      ids.push((r as { messageId: string }).messageId);
    }
    return ids;
  }

  it("marks read, starred and filed in one call each", async () => {
    const [first, second, third] = await three();

    expect(
      await j(await post("/api/messages/bulk", { ids: [first, second], action: "read" })),
    ).toMatchObject({
      action: "read",
      affected: 2,
    });
    // The third is still unread, and the two that were marked report only what moved.
    expect(
      (await j(await post("/api/messages/bulk", { ids: [first, second], action: "read" })))
        .affected,
    ).toBe(0);
    const unread = await j(await get("/api/messages?filter=unread"));
    expect(unread.items.map((m: { id: string }) => m.id)).toEqual([third]);

    await post("/api/messages/bulk", { ids: [first, third], action: "star" });
    const starred = await j(await get("/api/messages?starred=true&direction=all"));
    expect(starred.items.map((m: { id: string }) => m.id).sort()).toEqual([first, third].sort());
    // Unstarring is a filter too, so a view can promise "everything except the marked ones".
    const unstarred = await j(await get("/api/messages?starred=false"));
    expect(unstarred.items.map((m: { id: string }) => m.id)).toEqual([second]);

    await post("/api/messages/bulk", { ids: [second, third], action: "archive" });
    expect((await j(await get("/api/messages"))).items).toHaveLength(1);
    const filed = await j(await get("/api/messages?archived=archived"));
    expect(filed.total).toBe(2);
    await post("/api/messages/bulk", { ids: [second, third], action: "unarchive" });
    expect((await j(await get("/api/messages"))).total).toBe(3);
  });

  it("deletes the rows and the objects behind them", async () => {
    const [first, second] = await three();
    const before = await DB.prepare(`SELECT raw_r2_key FROM messages WHERE id = ?1`)
      .bind(first)
      .first<{ raw_r2_key: string }>();
    // Narrowing here is the point: a row with no raw key cannot prove the purge worked.
    if (!before) throw new Error("the stored row has no raw key to check against");

    const grant = await newGrant(DB, 60_000);
    const response = await post(
      "/api/messages/bulk",
      { ids: [first, second], action: "delete" },
      { "x-mailvault-stepup": grant.token },
    );
    expect(response.status).toBe(200);
    const res = await j(response);
    expect(res).toMatchObject({ action: "delete", affected: 2 });
    expect(res.r2ObjectsRemoved).toBe(0);
    await drainDeletionJobs(TEST_ENV);
    expect((await j(await get("/api/messages"))).total).toBe(1);
    expect(await BUCKET.get(before.raw_r2_key)).toBeNull();
  });

  it("reports nothing changed for ids that do not exist", async () => {
    await three();
    expect(
      (await j(await post("/api/messages/bulk", { ids: [newId(), newId()], action: "star" })))
        .affected,
    ).toBe(0);
    expect((await j(await get("/api/messages"))).total).toBe(3);
  });

  it("refuses an empty selection and an unknown action", async () => {
    expect((await post("/api/messages/bulk", { ids: [], action: "read" })).status).toBe(400);
    expect((await post("/api/messages/bulk", { ids: [newId()], action: "duplicate" })).status).toBe(
      400,
    );
  });
});

describe("the counts beside each view", () => {
  it("counts the mailbox, not the page", async () => {
    await deliver({ from: "a@one.example", subject: "One", body: "Body", messageId: "c-1" });
    const second = (await deliver({
      from: "b@two.example",
      subject: "Two",
      body: "Body",
      messageId: "c-2",
    })) as unknown as {
      messageId: string;
    };
    const sent = await composeTo(["friend@elsewhere.example"]);
    await post("/api/messages/bulk", { ids: [sent.id], action: "star" });
    await post("/api/messages/bulk", { ids: [second.messageId], action: "archive" });

    const counters = await j(await get("/api/messages/counters"));
    // One unread received message left in the working list; the other is filed.
    expect(counters.inbox).toEqual({ total: 1, unread: 1 });
    expect(counters.filed.total).toBe(1);
    expect(counters.sent.total).toBe(1);
    // A starred row counts wherever it lives, which is why it is not inside `inbox`.
    expect(counters.starred.total).toBe(1);
    expect(counters.mailboxes).toEqual([{ domainId, unread: 1 }]);

    // Asked for one mailbox, the totals narrow to that mailbox alone.
    const scoped = await j(await get(`/api/messages/counters?domainId=${domainId}`));
    expect(scoped.inbox.total).toBe(1);
    const other = await j(await get(`/api/messages/counters?domainId=${newId()}`));
    expect(other.inbox).toEqual({ total: 0, unread: 0 });
    expect(other.mailboxes).toEqual([]);
  });
});

describe("a query with operators in it", () => {
  beforeEach(async () => {
    await deliver({
      from: "billing@shop.example",
      subject: "Your order",
      body: "Your code is 441702",
      messageId: "o-1",
    });
    await deliver({
      from: "marco@friend.example",
      subject: "Dinner on Friday",
      body: "Running late, the table word is in:box",
      messageId: "o-2",
    });
    await composeTo(["marco@friend.example"], "Counting on you for dinner.");
  });

  it("separates who wrote from who it went to", async () => {
    const from = await j(await get("/api/messages?q=from%3Amarco%40friend.example"));
    expect(from.items.map((m: { subject: string }) => m.subject)).toEqual(["Dinner on Friday"]);
    // The same address as a recipient finds the letter that was sent to it, and only that:
    // received mail was addressed to the alias, not to the person who wrote it.
    const to = await j(await get("/api/messages?q=to%3Amarco&direction=all&filter=all"));
    expect(to.items.map((m: { subject: string }) => m.subject)).toEqual(["A letter"]);
  });

  it("finds the mail that carries a code", async () => {
    const withCode = await j(await get("/api/messages?q=has%3Acode"));
    expect(withCode.items.map((m: { subject: string }) => m.subject)).toEqual(["Your order"]);
  });

  it("searches sent mail without leaving the inbox tab", async () => {
    // `in:sent` overrides the direction the view asked for — that is the whole point of it.
    const sent = await j(await get("/api/messages?q=in%3Asent%20dinner"));
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0]).toMatchObject({ direction: "OUT", subject: "A letter" });
  });

  it("treats an operator it does not know as an ordinary word", async () => {
    // `in:box` is only a word pair, so the mail that contains it still has to be found.
    const body = await j(await get("/api/messages?q=in%3Abox"));
    expect(body.items.map((m: { subject: string }) => m.subject)).toEqual(["Dinner on Friday"]);
  });

  it("bounds by date", async () => {
    const future = await j(await get("/api/messages?q=after%3A2030-01-01"));
    expect(future.items).toHaveLength(0);
    // Two of the three are received mail, which is what a list with no direction shows.
    const past = await j(await get("/api/messages?q=after%3A2020-01-01"));
    expect(past.items).toHaveLength(2);
    expect(
      (await j(await get("/api/messages?q=after%3A2020-01-01&direction=all"))).items,
    ).toHaveLength(3);
  });
});

describe("a send that the other server answered", () => {
  const event = (
    providerMessageId: string,
    recipient: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    type: `cf.email.sending.message.${status}`,
    source: { type: "email.sending", zoneId: "z", domain: "mailbox.example" },
    payload: {
      messageId: providerMessageId,
      recipient,
      terminal: status !== "deferred",
      delivery: { status, smtpStatusCode: status === "delivered" ? "250" : "550", ...extra },
    },
    metadata: { eventTimestamp: new Date().toISOString() },
  });

  it("moves the message off queued and records it per address", async () => {
    const composed = await composeTo(["marco@friend.example", "other@friend.example"]);
    // Until an event lands, the honest word is still "queued", for every destination.
    const before = await j(await get(`/api/messages/${composed.id}`));
    expect(before.sendStatus).toBe(SendStatus.Queued);
    expect(before.recipients.map((r: { address: string }) => r.address)).toEqual([
      "marco@friend.example",
      "other@friend.example",
    ]);

    const { batch: b, seen } = batch(DELIVERY_QUEUE, [
      event(before.providerMessageId, "marco@friend.example", "delivered"),
      event(before.providerMessageId, "other@friend.example", "bounced", {
        smtpStatusCode: "550",
        smtpResponse: "550 no such user",
      }),
    ]);
    await worker.queue(b, TEST_ENV, CTX);
    expect(seen).toEqual(["ack", "ack"]);

    const after = await j(await get(`/api/messages/${composed.id}`));
    // One of two arrived, the other refused: the summary has to be the refusal.
    expect(after.sendStatus).toBe(SendStatus.Bounced);
    expect(
      after.recipients.find((r: { address: string }) => r.address === "marco@friend.example")
        .status,
    ).toBe(SendStatus.Delivered);
    expect(
      after.recipients.find((r: { address: string }) => r.address === "other@friend.example"),
    ).toMatchObject({
      status: SendStatus.Bounced,
      smtpCode: "550",
      detail: "550 no such user",
    });
    // The list badge reads the same summary without the join.
    const row = (await j(await get("/api/messages?direction=out&filter=all"))).items[0];
    expect(row).toMatchObject({ id: composed.id, sendStatus: SendStatus.Bounced });
  });

  it("never lets a late report undo one that already settled", async () => {
    const composed = await composeTo(["marco@friend.example"]);
    const providerId = (await j(await get(`/api/messages/${composed.id}`))).providerMessageId;

    await worker.queue(
      batch(DELIVERY_QUEUE, [event(providerId, "marco@friend.example", "delivered")]).batch,
      TEST_ENV,
      CTX,
    );
    // A retry report from an earlier attempt arriving after the delivery is not a rewind.
    await worker.queue(
      batch(DELIVERY_QUEUE, [event(providerId, "marco@friend.example", "deferred")]).batch,
      TEST_ENV,
      CTX,
    );
    const after = await j(await get(`/api/messages/${composed.id}`));
    expect(after.sendStatus).toBe(SendStatus.Delivered);
    expect(after.recipients[0].status).toBe(SendStatus.Delivered);
  });

  it("acknowledges an event for a message this mailbox never sent", async () => {
    await composeTo(["marco@friend.example"]);
    const { batch: b, seen } = batch(DELIVERY_QUEUE, [
      event("no-such-id@mailbox.example", "marco@friend.example", "delivered"),
    ]);
    await worker.queue(b, TEST_ENV, CTX);
    // Retrying could never make the id known, so the batch is drained rather than looped.
    expect(seen).toEqual(["ack"]);
    const detail = await j(await get("/api/messages?direction=out&filter=all"));
    expect(detail.items[0].sendStatus).toBe(SendStatus.Queued);
  });
});
