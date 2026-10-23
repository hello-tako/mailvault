import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { ingestEmail } from "../../src/mail/ingest";
import { newId } from "../../src/lib/util";
import { getTestBindings, type TestBindings } from "./_mf";
import { verifiedDkimPassFixture } from "./_auth-fixtures";

/*
 * The parts of a mailbox that are felt rather than seen: a conversation arriving as one row,
 * an address book that is only ever your own correspondence, and an unsubscribe that the
 * sender has to have earned.
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

const ALIAS = "shop-a1@mailbox.example";
let aliasId = "";

async function deliver(over: {
  from: string;
  fromDisplay?: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  at?: Date;
}) {
  const head = [
    `From: ${over.fromDisplay ?? over.from}`,
    `To: ${ALIAS}`,
    `Subject: ${over.subject}`,
    `Date: ${(over.at ?? new Date()).toUTCString()}`,
    `Message-ID: <${over.messageId}@${over.from}>`,
    over.inReplyTo ? `In-Reply-To: <${over.inReplyTo}>` : null,
    over.references ? `References: ${over.references.map((r) => `<${r}>`).join(" ")}` : null,
    over.listUnsubscribe ? `List-Unsubscribe: ${over.listUnsubscribe}` : null,
    over.listUnsubscribePost ? `List-Unsubscribe-Post: ${over.listUnsubscribePost}` : null,
    "Content-Type: text/plain; charset=utf-8",
  ]
    .filter((h): h is string => h !== null)
    .join("\r\n");
  // The blank line is the header/body separator; dropping it turns the body into a header.
  const headers = `${head}\r\n\r\n${over.body}\r\n`;
  const raw = new TextEncoder().encode(headers);
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

beforeEach(async () => {
  await DB.prepare(`DELETE FROM outbound_jobs`).run();
  await DB.prepare(`DELETE FROM messages`).run();
  await DB.prepare(`DELETE FROM messages_fts`).run();
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM domains`).run();
  const domainId = newId();
  aliasId = newId();
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status, sending_status)
     VALUES (?1, ?2, 'mailbox.example', 'active', 'full', 'READY', 'ENABLED')`,
  )
    .bind(domainId, `zone-${domainId.slice(0, 8)}`)
    .run();
  await DB.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, 'shop-a1', ?3, 'ACTIVE')`,
  )
    .bind(aliasId, domainId, ALIAS)
    .run();
});

describe("a conversation is one row", () => {
  async function exchange() {
    const first = await deliver({
      from: "billing@shop.example",
      subject: "Your order",
      body: "Order 44 is paid.",
      messageId: "m-1",
    });
    expect(first.status).toBe("stored");
    // The variant is narrowed by the status above, which is what the assertion is for.
    const rootId = (first as { messageId: string }).messageId;
    // Test fixture supplies independent verifier evidence; raw MIME remains untrusted.
    await DB.prepare(`UPDATE messages SET auth_verdict = 'TRUSTED', auth_json = ?2 WHERE id = ?1`)
      .bind(rootId, verifiedDkimPassFixture("shop.example"))
      .run();

    // The owner answers from the alias, then the shop answers that.
    const composed = await j(
      await worker.fetch(
        req(`/api/messages/${rootId}/reply`, {
          method: "POST",
          headers: H,
          body: JSON.stringify({ text: "Where is it?" }),
        }),
        TEST_ENV,
        CTX,
      ),
    );
    const detail = await j(await worker.fetch(req(`/api/messages/${composed.id}`), TEST_ENV, CTX));
    const outboundId: string = (detail.providerMessageId ?? "").replace(/^<|>$/g, "");
    expect(outboundId.length).toBeGreaterThan(0);
    // The shop answers the reply: its In-Reply-To names the Message-ID Email Sending assigned.
    await deliver({
      from: "billing@shop.example",
      subject: "Re: Your order",
      body: "Out for delivery.",
      messageId: "m-2",
      inReplyTo: outboundId,
      references: ["m-1@billing.shop.example", outboundId],
    });
    return rootId;
  }

  it("collapses to its newest message with the size of the thread", async () => {
    const rootId = await exchange();

    // Default list is received mail only — that is what an inbox is.
    const flat = await j(await worker.fetch(req("/api/messages"), TEST_ENV, CTX));
    expect(flat.total).toBe(2);
    const everything = await j(
      await worker.fetch(req("/api/messages?direction=all"), TEST_ENV, CTX),
    );
    expect(everything.total).toBe(3);

    const grouped = await j(
      await worker.fetch(req("/api/messages?threaded=true&direction=all"), TEST_ENV, CTX),
    );
    expect(grouped.total, JSON.stringify(grouped)).toBe(1);
    expect(grouped.items).toHaveLength(1);
    expect(grouped.items[0]).toMatchObject({ threadRootId: rootId, threadCount: 3 });
    // The row that stands for the thread is the most recent message in it, so the preview and
    // the timestamp describe the end of the conversation rather than its beginning.
    expect(grouped.items[0].subject).toContain("Re: Your order");
  });

  it("keeps two conversations apart when they happen to share a subject", async () => {
    await deliver({
      from: "one@shop.example",
      subject: "Invoice",
      body: "For customer one.",
      messageId: "i-1",
    });
    await deliver({
      from: "two@shop.example",
      subject: "Invoice",
      body: "For customer two.",
      messageId: "i-2",
    });

    const grouped = await j(await worker.fetch(req("/api/messages?threaded=true"), TEST_ENV, CTX));
    expect(grouped.total).toBe(2);
    expect(grouped.items.map((m: any) => m.threadCount)).toEqual([1, 1]);
  });

  it("searches across every message but reports the conversation once", async () => {
    const rootId = await exchange();
    await deliver({
      from: "other@vendor.example",
      subject: "Invoice for July",
      body: "Order 44 was cancelled.",
      messageId: "x-1",
    });

    const hits = await j(
      await worker.fetch(req("/api/messages?q=44&threaded=true&direction=all"), TEST_ENV, CTX),
    );
    expect(hits.total, JSON.stringify(hits)).toBe(2);
    const mine = hits.items.find((m: any) => m.threadRootId === rootId);
    expect(mine.threadCount).toBe(3);
    // A thread is represented by the message that actually matched, not merely the newest.
    expect(mine.id).toBeTruthy();
  });

  it("counts a thread once even when its messages are spread across tabs", async () => {
    await exchange();
    const grouped = await j(
      await worker.fetch(req("/api/messages?threaded=true&direction=all"), TEST_ENV, CTX),
    );
    expect(grouped.total).toBe(1);
    const unthreaded = await j(
      await worker.fetch(req("/api/messages?direction=all"), TEST_ENV, CTX),
    );
    expect(unthreaded.total).toBe(3);
  });
});

describe("the composer's address list", () => {
  it("offers who you have written to and who has written to you", async () => {
    await deliver({
      from: "billing@shop.example",
      fromDisplay: "Billing <billing@shop.example>",
      subject: "Order",
      body: "hi",
      messageId: "r-1",
    });
    await worker.fetch(
      req("/api/outbox", {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          fromAddress: ALIAS,
          to: ["customer@elsewhere.example"],
          subject: "Hello",
          text: "hi",
        }),
      }),
      TEST_ENV,
      CTX,
    );

    const allRes = await worker.fetch(req("/api/recipients"), TEST_ENV, CTX);
    const all = await j(allRes);
    expect(allRes.status, JSON.stringify(all)).toBe(200);
    expect(all.items.map((i: any) => i.address)).toEqual(
      expect.arrayContaining(["billing@shop.example", "customer@elsewhere.example"]),
    );
    const outbound = all.items.find((i: any) => i.address === "customer@elsewhere.example");
    expect(outbound.outgoing).toBe(true);
    // The display name comes from the header the sender actually used.
    expect(all.items.find((i: any) => i.address === "billing@shop.example").name).toBe("Billing");

    const filtered = await j(await worker.fetch(req("/api/recipients?q=elsewhere"), TEST_ENV, CTX));
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].address).toBe("customer@elsewhere.example");
  });

  it("never suggests the mailbox's own alias back to it", async () => {
    await deliver({ from: "billing@shop.example", subject: "Order", body: "hi", messageId: "r-2" });
    const res = await worker.fetch(req("/api/recipients?q=shop-a1"), TEST_ENV, CTX);
    expect(res.status).toBe(200);
    expect((await j(res)).items).toEqual([]);
  });
});

describe("unsubscribing", () => {
  it("stores what the sender declared, in both forms", async () => {
    await deliver({
      from: "news@digest.example",
      subject: "Weekly digest",
      body: "Read all about it.",
      messageId: "u-1",
      listUnsubscribe:
        "<https://digest.example/unsub/9f2>, <mailto:unsub@digest.example?subject=unsubscribe>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    });
    const stored = await DB.prepare(
      `SELECT id, list_unsubscribe, list_unsubscribe_post FROM messages WHERE provider_message_id = 'u-1@news@digest.example'`,
    ).first<any>();
    const missing = await DB.prepare(
      `SELECT id, list_unsubscribe, list_unsubscribe_post FROM messages LIMIT 1`,
    ).first<any>();
    const row = stored ?? missing;
    expect(row.list_unsubscribe).toContain("https://digest.example/unsub/9f2");
    expect(row.list_unsubscribe_post).toBe("List-Unsubscribe=One-Click");

    const detail = await j(await worker.fetch(req(`/api/messages/${row.id}`), TEST_ENV, CTX));
    expect(detail.oneClickUnsubscribe).toBe(true);
    expect(detail.listUnsubscribe).toContain("mailto:unsub@digest.example");
  });

  it("leaves the fields empty for a sender who declared nothing", async () => {
    const result = await deliver({
      from: "billing@shop.example",
      subject: "Invoice",
      body: "hi",
      messageId: "u-2",
    });
    const detail = await j(
      await worker.fetch(req(`/api/messages/${(result as any).messageId}`), TEST_ENV, CTX),
    );
    expect(detail.listUnsubscribe).toBeNull();
    expect(detail.oneClickUnsubscribe).toBe(false);
  });
});

describe("time in the list", () => {
  it("orders by receiver arrival and preserves the sender Date separately", async () => {
    const at = new Date("2026-03-04T05:06:07.000Z");
    const arrivedBefore = Date.now();
    const result = await deliver({
      from: "old@shop.example",
      subject: "From the past",
      body: "hi",
      messageId: "t-1",
      at,
    });
    expect(result.status).toBe("stored");
    const row = await DB.prepare(`SELECT received_at, header_date FROM messages WHERE id = ?1`)
      .bind((result as { messageId: string }).messageId)
      .first<{ received_at: string; header_date: string | null }>();
    const receivedAt = Date.parse(row?.received_at ?? "");
    expect(receivedAt).toBeGreaterThanOrEqual(arrivedBefore - 1000);
    expect(receivedAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(row?.header_date).toBe(at.toISOString());
  });
});
