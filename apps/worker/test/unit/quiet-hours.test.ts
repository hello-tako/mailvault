import { describe, expect, it } from "vitest";
import { digestDueAt, isQuietAt, parseQuietHours } from "../../src/lib/quiet-hours";

const at = (utc: string) => new Date(`2026-10-25T${utc}:00Z`);

describe("quiet hours (D2)", () => {
  it("parses only a sane, non-degenerate window", () => {
    expect(parseQuietHours(JSON.stringify({ startMin: 22 * 60, endMin: 7 * 60, tzOffsetMin: 420 }))).toEqual({
      startMin: 1320,
      endMin: 420,
      tzOffsetMin: 420,
    });
    expect(parseQuietHours(JSON.stringify({ startMin: 600, endMin: 600, tzOffsetMin: 0 }))).toBeNull();
    expect(parseQuietHours("not json")).toBeNull();
    expect(parseQuietHours(JSON.stringify({ startMin: -5, endMin: 60, tzOffsetMin: 0 }))).toBeNull();
  });

  it("knows when it is quiet, including a window that wraps midnight", () => {
    const qh = { startMin: 22 * 60, endMin: 7 * 60, tzOffsetMin: 0 }; // 22:00–07:00 UTC
    expect(isQuietAt(qh, at("23:30"))).toBe(true);
    expect(isQuietAt(qh, at("03:00"))).toBe(true);
    expect(isQuietAt(qh, at("12:00"))).toBe(false);
    expect(isQuietAt(qh, at("07:30"))).toBe(false);
  });

  it("honours the owner's timezone offset", () => {
    const qh = { startMin: 22 * 60, endMin: 7 * 60, tzOffsetMin: 420 }; // UTC+7 local wall clock
    // 16:30 UTC is 23:30 local — inside.
    expect(isQuietAt(qh, at("16:30"))).toBe(true);
    // 00:30 UTC is 07:30 local — outside.
    expect(isQuietAt(qh, at("00:30"))).toBe(false);
  });

  it("calls one digest, in the hour after the window ends, once per day", () => {
    const qh = { startMin: 22 * 60, endMin: 7 * 60, tzOffsetMin: 0 };
    expect(digestDueAt(qh, at("07:20"), null)).toBe(true);
    expect(digestDueAt(qh, at("07:20"), "2026-10-25")).toBe(false);
    expect(digestDueAt(qh, at("09:00"), null)).toBe(false);
    expect(digestDueAt(qh, at("23:00"), null)).toBe(false); // still quiet, no digest yet
  });
});
