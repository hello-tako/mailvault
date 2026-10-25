import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const timestamp = z.string().datetime({ precision: 3 });
export const OtpRpcRequestSchema = z.object({
  v: z.literal(1),
  operation: z.enum(["validateAlias", "lookupLoginOtp"]),
  aliasId: id,
  providerKey: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  grantId: id,
  notBefore: timestamp,
  issuedAt: timestamp,
  requestId: z.string().uuid(),
  mac: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type OtpRpcRequestV1 = z.infer<typeof OtpRpcRequestSchema>;
export type AliasValidation = {
  state: "active" | "inactive" | "not_found" | "routing_unknown";
  aliasId: string;
};
export type LoginOtpResult =
  | { state: "found"; code: string; receivedAt: string; messageRef: string }
  | { state: "pending" | "ambiguous" | "untrusted" | "unavailable" };

export function canonicalRequest(input: Omit<OtpRpcRequestV1, "mac">): string {
  return JSON.stringify(["TUNG-OTP-BRIDGE", input.v, input.operation, input.aliasId,
    input.providerKey, input.grantId, input.notBefore, input.issuedAt, input.requestId]);
}
