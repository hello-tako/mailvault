import { AuthVerdict, type ExtractedCode } from "@mailvault/shared";

/**
 * Which code a customer is shown.
 *
 * The vault keeps every number it found in a message, and real mail is full of numbers that
 * are not one-time codes: Meta's footer carries its own postcode (94025) in every message it
 * sends, and it scores 0.47 while the code above it scores 0.65. The list endpoint can afford
 * to show the strongest candidate because a human reads it beside the subject; a portal that
 * answers a stranger cannot, so it applies two rules the inbox does not need — a confidence
 * floor, and a window of minutes in which a code can still be worth delivering.
 *
 * A spoofed message never yields a code here, whatever its confidence: that number is the
 * payload a phisher wanted somebody to type somewhere.
 */

/** Below this, the digits are usually an address, a year or a postcode. */
export const PORTAL_MIN_CONFIDENCE = 0.6;

/** How long a code counts as still the one the customer is waiting for. */
export const PORTAL_WINDOW_MINUTES = 30;

export interface PortalCandidate {
  messageId: string;
  receivedAt: string;
  authVerdict: AuthVerdict;
  codes: ExtractedCode[];
}

export interface PortalCode {
  messageId: string;
  code: string;
  kind: ExtractedCode["kind"];
  ageSeconds: number;
}

export function pickPortalCode(
  candidates: PortalCandidate[],
  now: Date = new Date(),
  windowMinutes: number = PORTAL_WINDOW_MINUTES,
): PortalCode | null {
  const floor = now.getTime() - windowMinutes * 60_000;
  let best: { code: ExtractedCode; message: PortalCandidate } | null = null;

  for (const message of candidates) {
    if (message.authVerdict === AuthVerdict.Spoofed) continue;
    const arrived = Date.parse(message.receivedAt);
    // Nothing newer to find: the query returns newest-first, but a caller that hands us an
    // unsorted list still gets the right answer.
    if (!Number.isFinite(arrived) || arrived < floor) continue;

    for (const code of message.codes) {
      if (code.confidence < PORTAL_MIN_CONFIDENCE) continue;
      if (!best) {
        best = { code, message };
        continue;
      }
      const wins =
        code.confidence > best.code.confidence ||
        (code.confidence === best.code.confidence &&
          (code.length > best.code.length ||
            (code.length === best.code.length && arrived > Date.parse(best.message.receivedAt))));
      if (wins) best = { code, message };
    }
  }

  if (!best) return null;
  return {
    messageId: best.message.messageId,
    code: best.code.value,
    kind: best.code.kind,
    ageSeconds: Math.max(0, Math.round((now.getTime() - Date.parse(best.message.receivedAt)) / 1000)),
  };
}
