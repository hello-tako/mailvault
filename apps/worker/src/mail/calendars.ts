import { getObject } from "../storage/r2";

/**
 * The two "open this elsewhere" attachments a mailbox can read by itself (C9): a calendar
 * invite and a contact card. Parsing is deliberately small — unfold the vCard/iCalendar
 * line folding, lift the fields worth showing, and let the download link carry the rest.
 * Anything unparsable is simply absent from the response, never an error: the file is
 * unchanged and still downloadable.
 */

export interface CalendarInvite {
  summary: string | null;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
}

export interface VCard {
  name: string | null;
  org: string | null;
  email: string | null;
}

function unfold(raw: string): string[] {
  return raw.replace(/\r\n[ \t]/g, "").split(/\r?\n/);
}

function pick(lines: string[], key: string): string | null {
  const line = lines.find((l) => l.toUpperCase().startsWith(`${key}:`));
  const value = line?.slice(line.indexOf(":") + 1).trim();
  return value ? value : null;
}

/** iCalendar writes timestamps as 20261025T090000Z or with a TZ offset; both render as-is. */
function icsWhen(value: string | null): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return value;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}${m[7] === "Z" ? " UTC" : ""}`;
}

export async function readInvite(
  bucket: R2Bucket,
  r2Key: string,
  size: number,
): Promise<CalendarInvite | null> {
  if (size > 64 * 1024) return null;
  const obj = await getObject(bucket, r2Key).catch(() => null);
  if (!obj) return null;
  const lines = unfold(await obj.text());
  if (!lines.some((l) => l.toUpperCase().startsWith("BEGIN:VEVENT"))) return null;
  return {
    summary: pick(lines, "SUMMARY"),
    startsAt: icsWhen(pick(lines, "DTSTART")),
    endsAt: icsWhen(pick(lines, "DTEND")),
    location: pick(lines, "LOCATION"),
  };
}

export async function readVCard(
  bucket: R2Bucket,
  r2Key: string,
  size: number,
): Promise<VCard | null> {
  if (size > 64 * 1024) return null;
  const obj = await getObject(bucket, r2Key).catch(() => null);
  if (!obj) return null;
  const lines = unfold(await obj.text());
  if (!lines.some((l) => l.toUpperCase().startsWith("BEGIN:VCARD"))) return null;
  return {
    name: pick(lines, "FN") ?? pick(lines, "N"),
    org: pick(lines, "ORG"),
    email: pick(lines, "EMAIL"),
  };
}
