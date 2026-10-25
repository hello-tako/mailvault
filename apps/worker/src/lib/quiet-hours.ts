/**
 * Quiet hours (plan D2): the window in which mail keeps arriving but the owner asked not
 * to be interrupted. Stored in app_settings as `{startMin,endMin,tzOffsetMin}` — minutes
 * from local midnight in the owner's own timezone, so DST and travel are the browser's
 * business when it saves the setting, and plain arithmetic here.
 */

export interface QuietHours {
  startMin: number;
  endMin: number;
  tzOffsetMin: number;
}

export function parseQuietHours(raw: string | null): QuietHours | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<QuietHours>;
    const start = Number(parsed.startMin);
    const end = Number(parsed.endMin);
    const tz = Number(parsed.tzOffsetMin);
    if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(tz)) return null;
    if (start < 0 || start > 1439 || end < 0 || end > 1439 || Math.abs(tz) > 840) return null;
    if (start === end) return null; // a 24h silence is the notifications switch, not this
    return { startMin: start, endMin: end, tzOffsetMin: tz };
  } catch {
    return null;
  }
}

/** Local-wall-clock minutes since midnight for `now`, in the owner's timezone.
 * `tzOffsetMin` is the browser's offset east of UTC (420 for UTC+7), the same sign
 * `-getTimezoneOffset()` produces at save time. */
export function localMinutes(now: Date, tzOffsetMin: number): number {
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return ((utcMin + tzOffsetMin) % 1440 + 1440) % 1440;
}

export function isQuietAt(qh: QuietHours, now: Date): boolean {
  const m = localMinutes(now, qh.tzOffsetMin);
  return qh.startMin < qh.endMin
    ? m >= qh.startMin && m < qh.endMin
    : m >= qh.startMin || m < qh.endMin; // wraps midnight
}

/**
 * The digest moment: the first hour after the window ends. The hourly cron checks this —
 * one payload-free push that lets the phone say what piled up, deduped per day.
 */
export function digestDueAt(qh: QuietHours, now: Date, lastDigestDay: string | null): boolean {
  if (isQuietAt(qh, now)) return false;
  const end = localMinutes(new Date(now.getTime()), qh.tzOffsetMin);
  const minutesSinceEnd = ((end - qh.endMin) % 1440 + 1440) % 1440;
  if (minutesSinceEnd >= 60) return false;
  const day = now.toISOString().slice(0, 10);
  return lastDigestDay !== day;
}
