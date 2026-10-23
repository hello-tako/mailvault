import { grantIsValid } from "../db/security";
import { forbidden } from "../lib/errors";
import { log } from "../lib/logging";

/** Operations that require proof of a recent passkey assertion. */
export type IrreversibleOperation =
  | "message.delete"
  | "message.bulk-delete"
  | "alias.purge"
  | "domain.forget"
  | "provision.mx-takeover"
  | "provision.catch-all-takeover"
  | "semantic.purge"
  | "dmarc.takeover"
  | "auth-policy.weaken"
  | "passkey.remove"
  | "passkey.enroll";

export const STEP_UP_HEADER = "x-mailvault-stepup";

/** Shared server policy for handlers that cannot be undone. */
export async function requireIrreversibleStepUp(
  db: D1Database,
  token: string | undefined,
  operation: IrreversibleOperation,
): Promise<void> {
  if (await grantIsValid(db, token)) return;
  log.warn("step_up_required", { operation });
  throw forbidden("Unlock with your passkey first", { stepUpRequired: true });
}
