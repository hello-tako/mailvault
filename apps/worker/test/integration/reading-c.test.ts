import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { getTestBindings, type TestBindings } from "./_mf";
import { newId } from "../../src/lib/util";
import { listMessages } from "../../src/db/messages";

let bindings: TestBindings;
let TEST_ENV: Env;
let DB: D1Database;
let aliasAddress = "";

const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const j = async (r: Response): Promise<any> => r.json();
const H = { "x-mailvault": "1", "content-type": "application/json" };
const req = (path: string, init: RequestInit = {}): Request =>
  new Request(`http://localhost${path}`, { ...init, headers: { origin: "http://localhost", ...(init.headers ?? {}) } });

/** One send, straight to the point. */
async function send(payload: Record<string, unknown>): Promise<any> {
  const res = await worker.fetch(
    req("/api/outbox", {
      method: "POST",
      headers: { ...H, "Idempotency-Key": newId() },
      body: JSON.stringify({ fromAddress: aliasAddress, to: ["a@b.example"], ...payload }),
    }),
    TEST_ENV,
    CTX,
  );
  expect(res.status).toBe(201);
  return j(res);
}

beforeAll(async () => {
  bindings = await getTestBindings();
  TEST_ENV = bindings.env as unknown as Env;
  DB = bindings.db;
  (TEST_ENV as any).EMAIL = {
    send: async () => ({ messageId: `<wire-${newId()}@send.example>` }),
  };
});

beforeEach(async () => {
  // Old mail keeps its domain (the tombstone trigger forbids deleting one that holds
  // messages), so each test gets a fresh domain of its own instead.
  const domainId = newId();
  const local = `rc-${domainId.slice(0, 8)}`;
  const domainName = `send-${domainId.slice(0, 6)}.example`;
  aliasAddress = `${local}@${domainName}`;
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status, sending_status)
     VALUES (?1, ?2, ?3, 'active', 'full', 'READY', 'ENABLED')`,
  ).bind(domainId, `z-${domainId.slice(0, 8)}`, domainName).run();
  await DB.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, ?3, ?4, 'ACTIVE')`,
  ).bind(newId(), domainId, local, aliasAddress).run();
});

const search = (q: string) =>
  listMessages(DB, { filter: "all", archived: "all", direction: "all", limit: 10, offset: 0, q });

describe("search grows a subject filter and attachment flavours (C12)", () => {
  it("finds by subject: and tells flavours apart with has:image / has:pdf", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await send({ subject: "Quarterly rhubarb report", text: "plain words about pie" });
    await send({
      subject: "with files",
      text: "two files",
      attachments: [
        { filename: "pic.png", type: "image/png", content: png },
        { filename: "doc.pdf", type: "application/pdf", content: png },
      ],
    });

    expect((await search("subject:rhubarb")).items).toHaveLength(1);
    expect((await search("subject:rhubarb pie")).items).toHaveLength(0);
    expect((await search("has:image")).items).toHaveLength(1);
    expect((await search("has:pdf")).items).toHaveLength(1);
  });
});

describe("invites, cards and translation (C9, C11)", () => {
  it("parses an .ics and a .vcf attachment into readable cards", async () => {
    const ics = btoa(
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Dentist\r\nDTSTART:20261101T090000Z\r\nDTEND:20261101T100000Z\r\nLOCATION:Clinic\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    );
    const vcf = btoa("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Dr. Molar\r\nORG:Clinic\r\nEMAIL:dr@molar.example\r\nEND:VCARD\r\n");
    const sent = await send({
      subject: "appointment",
      text: "see attachments",
      attachments: [
        { filename: "invite.ics", type: "text/calendar", content: ics },
        { filename: "card.vcf", type: "text/vcard", content: vcf },
      ],
    });
    const detail = await j(await worker.fetch(req(`/api/messages/${sent.id}`, { headers: H }), TEST_ENV, CTX));
    expect(detail.calendar?.summary).toBe("Dentist");
    expect(detail.calendar?.startsAt).toContain("2026-11-01 09:00");
    expect(detail.vcard?.name).toBe("Dr. Molar");
    expect(detail.vcard?.email).toBe("dr@molar.example");
  });

  it("translates on demand through the AI binding, without storing anything", async () => {
    const sent = await send({ subject: "words", text: "hello there" });
    (TEST_ENV as any).AI = {
      run: async (_model: string, input: any) => ({ response: `VI: ${input.messages[1].content}` }),
    };
    const res = await worker.fetch(
      req(`/api/messages/${sent.id}/translate`, { method: "POST", headers: H, body: JSON.stringify({ to: "vi" }) }),
      TEST_ENV,
      CTX,
    );
    expect(res.status).toBe(200);
    const translated = await j(res);
    expect(translated.text).toBe("VI: hello there");
    // Nothing persisted: the parsed copy still holds only what was sent.
    const detail = await j(await worker.fetch(req(`/api/messages/${sent.id}`, { headers: H }), TEST_ENV, CTX));
    expect(detail.textBody).toBe("hello there");
  });
});
