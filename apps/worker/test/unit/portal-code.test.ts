import { describe, expect, it } from "vitest";
import { AuthVerdict, type ExtractedCode } from "@mailvault/shared";
import { PORTAL_WINDOW_MINUTES, pickPortalCode, type PortalCandidate } from "../../src/portal/code";

/*
 * A portal that answers a stranger has to be stricter than an inbox that shows a human the
 * subject beside the number. Meta puts its own postcode (94025) in every footer at 0.47
 * confidence, and that is the exact thing a customer would type into the wrong field.
 */

const NOW = new Date("2026-04-14T09:00:00.000Z");

function code(value: string, confidence: number, kind: ExtractedCode["kind"] = "numeric"): ExtractedCode {
  return { value, kind, length: value.length, confidence };
}

function candidate(
  receivedAt: string,
  codes: ExtractedCode[],
  authVerdict: AuthVerdict = AuthVerdict.Trusted,
): PortalCandidate {
  return { messageId: `m-${receivedAt}`, receivedAt, authVerdict, codes };
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("which code a customer is handed", () => {
  it("ignores a postcode that ranks below the confidence floor", () => {
    const picked = pickPortalCode(
      [candidate(minutesAgo(2), [code("428954", 0.65), code("94025", 0.47)], AuthVerdict.Unverified)],
      NOW,
    );
    expect(picked?.code).toBe("428954");
    expect(picked?.kind).toBe("numeric");
  });

  it("says nothing when the only numbers in the window are not codes", () => {
    const picked = pickPortalCode([candidate(minutesAgo(2), [code("94025", 0.47), code("2026", 0.3)])], NOW);
    expect(picked).toBeNull();
  });

  it("will not serve a code from mail that failed authentication", () => {
    const picked = pickPortalCode(
      [candidate(minutesAgo(1), [code("111222", 0.99)], AuthVerdict.Spoofed)],
      NOW,
    );
    expect(picked).toBeNull();
  });

  it("stops answering once the window has passed", () => {
    const stale = candidate(minutesAgo(PORTAL_WINDOW_MINUTES + 1), [code("333444", 0.9)]);
    expect(pickPortalCode([stale], NOW)).toBeNull();
    // Exactly on the edge is still the code the customer asked for.
    expect(pickPortalCode([candidate(minutesAgo(PORTAL_WINDOW_MINUTES), [code("333444", 0.9)])], NOW)?.code).toBe("333444");
  });

  it("prefers the newest window entry over a stronger one nobody is waiting for", () => {
    const picked = pickPortalCode(
      [
        candidate(minutesAgo(1), [code("600600", 0.7)]),
        candidate(minutesAgo(PORTAL_WINDOW_MINUTES + 5), [code("999999", 0.99)]),
      ],
      NOW,
    );
    expect(picked?.code).toBe("600600");
  });

  it("breaks a confidence tie by length, then by recency", () => {
    expect(
      pickPortalCode(
        [candidate(minutesAgo(3), [code("1234", 0.8), code("123456", 0.8)])],
        NOW,
      )?.code,
    ).toBe("123456");
    expect(
      pickPortalCode(
        [candidate(minutesAgo(3), [code("123456", 0.8)]), candidate(minutesAgo(1), [code("654321", 0.8)])],
        NOW,
      )?.code,
    ).toBe("654321");
  });

  it("gives the right answer for a list that did not arrive newest-first", () => {
    const picked = pickPortalCode(
      [
        candidate(minutesAgo(20), [code("111111", 0.62)]),
        candidate(minutesAgo(1), [code("222222", 0.8)]),
      ],
      NOW,
    );
    expect(picked?.code).toBe("222222");
  });

  it("reports the code's age in whole seconds and never a negative one", () => {
    expect(pickPortalCode([candidate(minutesAgo(2), [code("778899", 0.9)])], NOW)?.ageSeconds).toBe(120);
    expect(pickPortalCode([candidate(new Date(NOW.getTime() + 5_000).toISOString(), [code("778899", 0.9)])], NOW)?.ageSeconds).toBe(0);
  });

  it("keeps an alphanumeric code labelled as one", () => {
    const picked = pickPortalCode([candidate(minutesAgo(1), [code("AB12-CD", 0.75, "alphanumeric")])], NOW);
    expect(picked).toMatchObject({ code: "AB12-CD", kind: "alphanumeric" });
  });
});
