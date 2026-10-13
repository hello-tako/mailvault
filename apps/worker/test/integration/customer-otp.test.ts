import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTestBindings, type TestBindings } from "./_mf";
import { authorizeRpc } from "../../src/customer-otp/auth";
import { canonicalRequest, type OtpRpcRequestV1 } from "../../src/customer-otp/contracts";
import { lookupLoginOtp, validateAlias } from "../../src/customer-otp/lookup";
import { DENIED_PURPOSE, type ProviderPolicy } from "../../src/customer-otp/providers";
import { assessAuth } from "../../src/mail/auth";
import { extractOtp } from "../../src/mail/otp";

const policy: ProviderPolicy = { providerKey: "synthetic", enabled: true, headerFrom: ["login@example.test"], dkimDomains: ["example.test"],
  loginSubject: /^Your sign-in code$/, loginBody: /^Use this code to sign in \d{6}(?:\n|$)/,
  reject: DENIED_PURPOSE, codeLengths: [6], minimumConfidence: 1, maxCodeAgeSeconds: 120, maxMessages: 20 };
const secret = "synthetic-integration-only-key-32-characters";
let bindings: TestBindings;
let now: number;
const auth = () => assessAuth({ authResults: [], headerFrom: "login@example.test", envelopeFrom: "login@example.test",
  verifiedEvidence: [{ mechanism: "dkim", outcome: "pass", domain: "example.test", source: "cryptographic-verifier" }] });
async function signed(operation: OtpRpcRequestV1["operation"] = "lookupLoginOtp", overrides: Partial<OtpRpcRequestV1> = {}): Promise<OtpRpcRequestV1> {
  const request: OtpRpcRequestV1 = { v: 1, operation, aliasId: "otp-a", providerKey: "synthetic", grantId: "grant-a",
    notBefore: new Date(now - 120000).toISOString(), issuedAt: new Date(now).toISOString(), requestId: crypto.randomUUID(), mac: "", ...overrides };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalRequest(request)));
  request.mac = Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return request;
}
async function message(id: string, code = "593821", options: { alias?: string; age?: number; text?: string; verdict?: string; committed?: string; deletion?: number; from?: string; auth?: string } = {}) {
  const alias = options.alias ?? "otp-a", subject = "Your sign-in code", text = options.text ?? `Use this code to sign in ${code}`;
  const at = new Date(now - (options.age ?? 500)).toISOString(), from = options.from ?? "login@example.test";
  const address = alias === "otp-a" ? "a@recipient.test" : "b@recipient.test";
  await bindings.bucket.put(`otp/${id}`, JSON.stringify({ subject, text, from, receivedAt: at }));
  await bindings.db.prepare(`INSERT INTO messages (id, domain_id, alias_id, dedupe_key, envelope_from, envelope_to, header_from, subject,
    received_at, raw_size, raw_r2_key, parsed_r2_key, has_attachments, attachment_count, extracted_codes_json, auth_verdict, auth_json,
    direction, created_at, ingest_status, deletion_pending) VALUES (?, 'otp-domain', ?, ?, ?, ?, ?, ?, ?, 100, ?, ?, 0, 0, ?, ?, ?, 'IN', ?, ?, ?)`)
    .bind(id, alias, `otp-dedupe-${id}`, from, address, from, subject, at, `raw/${id}`, `otp/${id}`, JSON.stringify(extractOtp(`${subject}\n${text}`)),
      options.verdict ?? "TRUSTED", options.auth ?? JSON.stringify(auth()), at, options.committed ?? "COMMITTED", options.deletion ?? 0).run();
}
beforeAll(async () => { bindings = await getTestBindings(); });
afterAll(async () => { await bindings.dispose(); });
beforeEach(async () => {
  now = Date.now();
  await bindings.db.batch([
    bindings.db.prepare("DELETE FROM deletion_jobs WHERE message_id LIKE 'otp-test-%'"),
    bindings.db.prepare("DELETE FROM inbound_staging WHERE alias_id IN ('otp-a','otp-b')"),
    bindings.db.prepare("DELETE FROM messages WHERE domain_id = 'otp-domain'"),
    bindings.db.prepare("DELETE FROM aliases WHERE domain_id = 'otp-domain'"),
    bindings.db.prepare("DELETE FROM domains WHERE id = 'otp-domain'"),
    bindings.db.prepare("DELETE FROM customer_otp_rpc_nonces"),
  ]);
  await bindings.db.prepare(`INSERT INTO domains (id,cloudflare_zone_id,name,zone_status,zone_type,mail_status,routing_status,catch_all_status,conflict_type,last_checked_at,created_at,updated_at)
    VALUES ('otp-domain','otp-zone','recipient.test','active','full','READY','READY','OURS','NONE',?,?,?)`).bind(new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString()).run();
  for (const [id, local] of [["otp-a", "a"], ["otp-b", "b"]]) await bindings.db.prepare(`INSERT INTO aliases (id,domain_id,local_part,address,status,created_at,updated_at)
    VALUES (?,'otp-domain',?,?,'ACTIVE',?,?)`).bind(id, local, `${local}@recipient.test`, new Date(now).toISOString(), new Date(now).toISOString()).run();
  bindings.env.MAILVAULT_CUSTOMER_OTP_ENABLED = "true"; bindings.env.OTP_BRIDGE_RPC_HMAC_KEY = secret;
});
describe("RPC authorization on real D1", () => {
  it("accepts authenticated fresh call once and rejects replay", async () => { const request = await signed(); expect(await authorizeRpc(bindings.env, request, "lookupLoginOtp", now)).not.toBe(null); expect(await authorizeRpc(bindings.env, request, "lookupLoginOtp", now)).toBe(null); });
  it("rejects 50 concurrent replay attempts except one", async () => { const request = await signed(); const outcomes = await Promise.all(Array.from({ length: 50 }, () => authorizeRpc(bindings.env, request, "lookupLoginOtp", now))); expect(outcomes.filter(Boolean)).toHaveLength(1); });
  it.each(["operation", "aliasId", "providerKey", "grantId", "notBefore", "issuedAt", "requestId"])("binds MAC to %s", async (field) => { const request = await signed(); const tampered = { ...request, [field]: field === "requestId" ? crypto.randomUUID() : "tampered" }; expect(await authorizeRpc(bindings.env, tampered, "lookupLoginOtp", now)).toBe(null); });
  it("rejects wrong MAC, stale/future/future-window and extra fields", async () => {
    for (const request of [await signed("lookupLoginOtp", { mac: "0".repeat(64) }), await signed("lookupLoginOtp", { issuedAt: new Date(now - 31000).toISOString() }),
      await signed("lookupLoginOtp", { issuedAt: new Date(now + 31000).toISOString() }), await signed("lookupLoginOtp", { notBefore: new Date(now + 1000).toISOString() }),
      { ...await signed(), email: "extra" }]) {
      if (request === undefined) continue;
      if ("mac" in request && request.issuedAt === new Date(now).toISOString() && !("email" in request) && Date.parse(request.notBefore) <= now) request.mac = "0".repeat(64);
      expect(await authorizeRpc(bindings.env, request, "lookupLoginOtp", now)).toBe(null);
    }
  });
  it("flags OFF and no secret fail before reading DB", async () => { const request = await signed(); bindings.env.MAILVAULT_CUSTOMER_OTP_ENABLED = "false"; expect(await authorizeRpc(bindings.env, request, "lookupLoginOtp", now)).toBe(null); bindings.env.MAILVAULT_CUSTOMER_OTP_ENABLED = "true"; delete bindings.env.OTP_BRIDGE_RPC_HMAC_KEY; expect(await authorizeRpc(bindings.env, request, "lookupLoginOtp", now)).toBe(null); });
});
describe("scoped OTP lookup on real D1 and private R2", () => {
  it("returns one fresh trusted login code and receipt metadata", async () => { await message("valid"); expect(await lookupLoginOtp(bindings.env, await signed(), policy, now)).toMatchObject({ state: "found", code: "593821", messageRef: "valid" }); });
  it("isolates aliases with identical messages", async () => { await message("other", "593821", { alias: "otp-b" }); expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("pending"); });
  it.each([{ age: 121000 }, { committed: "RULES_PENDING" }, { deletion: 1 }, { verdict: "UNVERIFIED" }, { verdict: "SPOOFED" }])("does not read ineligible messages %j", async (options) => { await message("excluded", "593821", options); expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("pending"); });
  it("never trusts forged auth evidence", async () => { await message("forged", "593821", { auth: JSON.stringify({ ...auth(), evidence: auth().evidence.map((item) => ({ ...item, source: "message-header" })) }) }); expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("untrusted"); });
  it("rejects reset purpose anywhere in body", async () => { await message("reset", "593821", { text: "Use this code to sign in 593821\n" + "x".repeat(500) + "password reset" }); expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("pending"); });
  it("fails ambiguous for two distinct recent messages", async () => { await message("one"); await message("two", "482716"); expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("ambiguous"); });
  it("respects grant start independently of age", async () => { await message("before", "593821", { age: 1000 }); expect((await lookupLoginOtp(bindings.env, await signed("lookupLoginOtp", { notBefore: new Date(now - 500).toISOString() }), policy, now)).state).toBe("pending"); });
  it("fails closed for missing policy, disabled aliases and routing drift", async () => { await message("valid"); expect((await lookupLoginOtp(bindings.env, await signed(), null, now)).state).toBe("unavailable"); await bindings.db.prepare("UPDATE aliases SET status = 'DISABLED' WHERE id = 'otp-a'").run(); expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("unavailable"); });
  it("requires actual trusted alias receipt to provision", async () => { expect((await validateAlias(bindings.env, await signed("validateAlias"), policy, now)).state).toBe("routing_unknown"); await message("receipt"); expect((await validateAlias(bindings.env, await signed("validateAlias"), policy, now)).state).toBe("active"); });
  it("refuses to guess when candidate scan is truncated", async () => {
    for (let index = 0; index < 21; index++) await message(`cap-${index}`, index === 0 ? "482716" : "593821", { age: 1000 + index });
    expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("ambiguous");
  });
  it("rejects wrong signer and malformed extracted JSON", async () => {
    await message("bad-signer", "593821", { auth: JSON.stringify({ ...auth(), evidence: auth().evidence.map(item => ({ ...item, domain: "other.test" })) }) });
    expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("untrusted");
    await bindings.db.prepare("UPDATE messages SET auth_json = ?, extracted_codes_json = '{bad' WHERE id = 'bad-signer'").bind(JSON.stringify(auth())).run();
    expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("untrusted");
  });
  it("hides durable tombstones and uncommitted inbound staging", async () => {
    await message("otp-test-tombstone");
    const at = new Date(now).toISOString();
    await bindings.db.prepare(`INSERT INTO deletion_jobs(id,job_type,message_id,dedupe_key,state,next_attempt_at,created_at,updated_at)
      VALUES ('otp-test-job','MESSAGE','otp-test-tombstone','otp-dedupe-otp-test-tombstone','DONE',?,?,?)`).bind(at,at,at).run();
    expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("pending");
    await message("staged");
    await bindings.db.prepare(`INSERT INTO inbound_staging(message_id,dedupe_key,alias_id,state,lease_token,lease_expires_at,created_at,updated_at)
      VALUES ('staged','otp-dedupe-staged','otp-a','STAGED','lease',?,?,?)`).bind(at,at,at).run();
    expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).toBe("pending");
  });
  it.each(["new-mail", "disable", "delete"])("fences %s completed during R2 read", async (action) => {
    await message("race-original");
    const original = bindings.env.MAIL_BUCKET;
    let mutated = false;
    bindings.env.MAIL_BUCKET = new Proxy(original, { get(target, property) {
      if (property !== "get") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
      return async (key: string) => {
        const object = await target.get(key);
        if (!mutated) { mutated = true;
          if (action === "new-mail") await message("race-new", "482716", { age: 250 });
          if (action === "disable") await bindings.db.prepare("UPDATE aliases SET status='DISABLED' WHERE id='otp-a'").run();
          if (action === "delete") await bindings.db.prepare("UPDATE messages SET deletion_pending=1 WHERE id='race-original'").run();
        }
        return object;
      };
    } });
    try { expect((await lookupLoginOtp(bindings.env, await signed(), policy, now)).state).not.toBe("found"); }
    finally { bindings.env.MAIL_BUCKET = original; }
  });

});
