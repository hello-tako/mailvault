import type { Env } from "../env";
import { canonicalRequest, OtpRpcRequestSchema, type OtpRpcRequestV1 } from "./contracts";

export async function authorizeRpc(
  env: Env, input: unknown, operation: OtpRpcRequestV1["operation"], now = Date.now(),
): Promise<OtpRpcRequestV1 | null> {
  if (env.MAILVAULT_CUSTOMER_OTP_ENABLED !== "true") return null;
  const secret = env.OTP_BRIDGE_RPC_HMAC_KEY;
  if (!secret || secret.length < 32 || secret.length > 512) return null;
  const parsed = OtpRpcRequestSchema.safeParse(input);
  if (!parsed.success || parsed.data.operation !== operation) return null;
  const request = parsed.data;
  const issued = Date.parse(request.issuedAt);
  const start = Date.parse(request.notBefore);
  if (Math.abs(now - issued) > 30_000 || start > now || start > issued) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(request.mac.match(/../g)!, (byte) => Number.parseInt(byte, 16));
  if (!(await crypto.subtle.verify("HMAC", key, signature,
    new TextEncoder().encode(canonicalRequest(request))))) return null;
  // Global nonce reservation survives separate isolates and concurrent callers.
  await env.DB.prepare(`DELETE FROM customer_otp_rpc_nonces WHERE request_id IN (
    SELECT request_id FROM customer_otp_rpc_nonces WHERE expires_at < ? LIMIT 200
  )`).bind(new Date(now).toISOString()).run();
  const reserved = await env.DB.prepare(`INSERT OR IGNORE INTO customer_otp_rpc_nonces
    (request_id, expires_at) VALUES (?, ?)`).bind(request.requestId,
    new Date(now + 60_000).toISOString()).run();
  return reserved.meta.changes === 1 ? request : null;
}
