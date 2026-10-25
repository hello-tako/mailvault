import type { Env } from "../env";
import { visibleMessageSql } from "../db/visibility";
import { classifyLoginCode, normalizeMailbox, trustedSender } from "./classify";
import type { AliasValidation, LoginOtpResult, OtpRpcRequestV1 } from "./contracts";
import type { ProviderPolicy } from "./providers";

interface AliasRow { id: string; address: string; status: string; zone_status: string; zone_type: string; mail_status: string; routing_status: string; catch_all_status: string; routing_verified_at: string | null }
interface Candidate { id: string; alias_id: string; envelope_to: string; header_from: string | null; subject: string | null; auth_json: string | null; extracted_codes_json: string | null; parsed_r2_key: string | null; received_at: string }

async function activeAlias(env: Env, aliasId: string, now: number): Promise<AliasRow | null> {
  const row = await env.DB.prepare(`SELECT a.id, a.address, a.status, d.zone_status, d.zone_type, d.mail_status,
    d.routing_status, d.catch_all_status, d.routing_verified_at FROM aliases a
    JOIN domains d ON d.id = a.domain_id WHERE a.id = ? LIMIT 1`).bind(aliasId).first<AliasRow>();
  if (!row || row.status !== "ACTIVE" || row.zone_status !== "active" || row.zone_type !== "full" || row.mail_status !== "READY" ||
    row.routing_status !== "READY" || row.catch_all_status !== "OURS" ||
    !row.routing_verified_at || !Number.isFinite(Date.parse(row.routing_verified_at)) ||
    now - Date.parse(row.routing_verified_at) > 2 * 60 * 60_000 || Date.parse(row.routing_verified_at) > now) return null;
  return row;
}

export async function validateAlias(env: Env, request: OtpRpcRequestV1, policy: ProviderPolicy | null, now = Date.now()): Promise<AliasValidation> {
  const result = { aliasId: request.aliasId };
  const alias = await env.DB.prepare("SELECT status FROM aliases WHERE id = ? LIMIT 1").bind(request.aliasId).first<{ status: string }>();
  if (!alias) return { ...result, state: "not_found" };
  if (alias.status !== "ACTIVE") return { ...result, state: "inactive" };
  if (!policy || !(await activeAlias(env, request.aliasId, now))) return { ...result, state: "routing_unknown" };
  // Routing readiness is a non-secret delivery-path proof. Provider-message trust is
  // evaluated only when a code is requested, so a cold alias can receive its first
  // post-entitlement login message without requiring a prior 24-hour receipt.
  return { ...result, state: "active" };
}

async function candidates(env: Env, aliasId: string, since: string, now: number, limit: number): Promise<Candidate[]> {
  const rows = await env.DB.prepare(`SELECT m.id, m.alias_id, m.envelope_to, m.header_from,
    m.subject, m.auth_json, m.extracted_codes_json, m.parsed_r2_key, m.received_at
    FROM messages m JOIN aliases alias ON alias.id = m.alias_id JOIN domains domain ON domain.id = alias.domain_id
    WHERE alias.status = 'ACTIVE' AND domain.zone_status = 'active' AND domain.zone_type = 'full' AND domain.mail_status = 'READY' AND domain.routing_status = 'READY' AND domain.catch_all_status = 'OURS'
    AND domain.routing_verified_at >= ? AND domain.routing_verified_at <= ?
    AND m.alias_id = ? AND m.direction = 'IN'
    AND m.ingest_status = 'COMMITTED' AND m.auth_verdict = 'TRUSTED'
    AND m.received_at >= ? AND m.received_at <= ? AND ${visibleMessageSql()}
    AND NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.message_id = m.id OR j.dedupe_key = m.dedupe_key)
    AND NOT EXISTS (SELECT 1 FROM inbound_staging s WHERE s.message_id = m.id AND s.state <> 'COMMITTED')
    ORDER BY m.received_at DESC, m.id DESC LIMIT ?`).bind(new Date(now - 2 * 60 * 60_000).toISOString(), new Date(now).toISOString(), aliasId, since,
    new Date(now).toISOString(), Math.max(1, Math.min(20, limit)) + 1).all<Candidate>();
  return rows.results ?? [];
}

export async function lookupLoginOtp(env: Env, request: OtpRpcRequestV1, policy: ProviderPolicy | null, now = Date.now()): Promise<LoginOtpResult> {
  if (!policy) return { state: "unavailable" };
  const alias = await activeAlias(env, request.aliasId, now);
  if (!alias) return { state: "unavailable" };
  const since = new Date(Math.max(Date.parse(request.notBefore), now - Math.min(120, policy.maxCodeAgeSeconds) * 1000)).toISOString();
  const rows = await candidates(env, request.aliasId, since, now, policy.maxMessages);
  if (rows.length > Math.min(20, policy.maxMessages)) return { state: "ambiguous" };
  const found: Array<{ code: string; row: Candidate }> = [];
  let untrusted = false;
  for (const row of rows) {
    if (normalizeMailbox(row.envelope_to) !== alias.address.toLowerCase() || !trustedSender(row.header_from, row.auth_json, policy)) {
      untrusted = true; continue;
    }
    // Full text is required to reject reset/recovery content outside the D1 preview.
    if (!row.parsed_r2_key) { untrusted = true; continue; }
    const object = await env.MAIL_BUCKET.get(row.parsed_r2_key);
    if (!object || object.size > 262_144) { untrusted = true; continue; }
    const parsed = await object.json<{ subject?: unknown; text?: unknown; from?: unknown; receivedAt?: unknown }>();
    if (typeof parsed.text !== "string" || parsed.subject !== row.subject || parsed.from !== row.header_from || parsed.receivedAt !== row.received_at) {
      untrusted = true; continue;
    }
    const selected = classifyLoginCode(row.subject ?? "", parsed.text, row.extracted_codes_json, policy);
    if (selected.state === "ambiguous") return selected;
    if (selected.state === "untrusted") untrusted = true;
    if (selected.state === "found") found.push({ code: selected.code, row });
  }
  if (new Set(found.map((item) => item.code)).size > 1) return { state: "ambiguous" };
  if (!found.length) return { state: untrusted ? "untrusted" : "pending" };
  const selected = found[0]!;
  // Deletion/disable completed while R2 was pending must fence the result too.
  if (!(await activeAlias(env, request.aliasId, Date.now()))) return { state: "unavailable" };
  const stillVisible = await candidates(env, request.aliasId, since, Date.now(), policy.maxMessages);
  if (Date.now() - Date.parse(selected.row.received_at) > Math.min(120, policy.maxCodeAgeSeconds) * 1000 ||
    stillVisible.length !== rows.length || stillVisible.some((row, index) => JSON.stringify(row) !== JSON.stringify(rows[index]))) return { state: "pending" };
  return { state: "found", code: selected.code, receivedAt: selected.row.received_at, messageRef: selected.row.id };
}
