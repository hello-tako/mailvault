import { beforeAll, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { getTestBindings, type TestBindings } from "./_mf";
import {
  cancelScheduledSend,
  listWaitingScheduled,
  scheduleSend,
  processScheduledSend,
} from "../../src/mail/scheduled";
import { listContacts, upsertContact, deleteContact } from "../../src/db/contacts";

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

let aliasAddress = "";

async function seedSendingDomain() {
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM domains`).run();
  const domainId = crypto.randomUUID();
  const local = `sched-${domainId.slice(0, 8)}`;
  aliasAddress = `${local}@send.example`;
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status, sending_status)
     VALUES (?1, ?2, 'send.example', 'active', 'full', 'READY', 'ENABLED')`,
  )
    .bind(domainId, `zone-${domainId.slice(0, 8)}`)
    .run();
  await DB.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, ?3, ?4, 'ACTIVE')`,
  )
    .bind(crypto.randomUUID(), domainId, local, aliasAddress)
    .run();
}

const sent: any[] = [];

beforeAll(async () => {
  bindings = await getTestBindings();
  TEST_ENV = bindings.env as unknown as Env;
  DB = bindings.db;
  // The same accepting stub the send suite uses: the wire is recorded, nothing leaves.
  (TEST_ENV as any).EMAIL = {
    send: async (message: unknown) => {
      sent.push(message);
      return { messageId: `<wire-${sent.length}@send.example>` };
    },
  };
  await seedSendingDomain();
});

describe("scheduled sends (B6)", () => {
  it("schedules over the API, lists the wait, and cancels before it fires", async () => {
    const res = await worker.fetch(
      req("/api/outbox/schedule", {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          kind: "compose",
          delaySeconds: 3600,
          input: {
            fromAddress: aliasAddress,
            to: ["late@example.net"],
            subject: "the night before",
            text: "written now, sent later",
          },
        }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(201);
    const { id } = await j(res);

    const listed = await j(await worker.fetch(req("/api/scheduled", { headers: H }), TEST_ENV, CTX));
    expect(listed.items.some((i: any) => i.id === id && i.subject === "the night before")).toBe(true);

    const cancelled = await worker.fetch(req(`/api/scheduled/${id}/cancel`, { method: "POST", headers: H }), TEST_ENV, CTX);
    expect((await j(cancelled)).cancelled).toBe(true);

    // A cancelled row must never fire, whatever the queue says.
    expect(await processScheduledSend(TEST_ENV, id)).toBe("skipped");
    const row = await DB.prepare(`SELECT state FROM scheduled_sends WHERE id = ?1`).bind(id).first<any>();
    expect(row.state).toBe("CANCELLED");
  });

  it("fires a waiting send through the normal outbound path", async () => {
    const { id } = await scheduleSend(DB, {
      kind: "compose",
      payload: {
        fromAddress: aliasAddress,
        to: ["on.time@example.net"],
        subject: "punctual",
        text: "right on schedule",
      },
      delaySeconds: 10,
    });
    const outcome = await processScheduledSend(TEST_ENV, id);
    expect(outcome).toBe("sent");
    const row = await DB.prepare(`SELECT state, message_id FROM scheduled_sends WHERE id = ?1`).bind(id).first<any>();
    expect(row.state).toBe("SENT");
    expect(row.message_id).toBeTruthy();
    const msg = await DB.prepare(`SELECT subject, direction FROM messages WHERE id = ?1`).bind(row.message_id).first<any>();
    expect(msg.subject).toBe("punctual");
    expect(msg.direction).toBe("OUT");
  });

  it("clamps an unreasonable delay into the day the queue can honour", async () => {
    const { sendAt } = await scheduleSend(DB, {
      kind: "compose",
      payload: { fromAddress: aliasAddress, to: ["y@example.net"], subject: "s", text: "t" },
      delaySeconds: 9_999_999,
    });
    expect(new Date(sendAt).getTime() - Date.now()).toBeLessThanOrEqual(86_400_000 + 5_000);
    // cleanup
    const waiting = await listWaitingScheduled(DB);
    for (const w of waiting) await cancelScheduledSend(DB, w.id);
  });
});

describe("contacts (B10)", () => {
  it("upserts by address, lists, and deletes", async () => {
    const first = await upsertContact(DB, { address: "Bank@Example.COM ", name: "Ngân hàng" });
    expect(first.address).toBe("bank@example.com");
    const again = await upsertContact(DB, { address: "bank@example.com", name: "Bank" });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Bank");

    const list = await listContacts(DB, "bank");
    expect(list).toHaveLength(1);

    expect(await deleteContact(DB, first.id)).toBe(true);
    expect(await listContacts(DB, "bank")).toHaveLength(0);
  });

  it("offers contacts ahead of correspondence history in the composer", async () => {
    await upsertContact(DB, { address: "vip@example.org", name: "VIP Desk" });
    const res = await worker.fetch(req("/api/recipients?q=vip", { headers: H }), TEST_ENV, CTX);
    const { items } = await j(res);
    expect(items[0]?.address).toBe("vip@example.org");
    expect(items[0]?.contact).toBe(true);
    await upsertContact(DB, { address: "cleanup@example.org" });
    // leave rows; harmless in dev state
  });
});
