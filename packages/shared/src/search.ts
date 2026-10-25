/**
 * Search operators — the part of a mailbox search that is not a word.
 *
 * One parser serves both sides on purpose. The Worker cannot trust a client to have
 * understood the query, so it re-parses `q` itself and applies the filters in SQL; the web
 * app parses the same string only to draw the chips. A second implementation would be a
 * second opinion about what the owner searched for, and the two would drift.
 *
 * Everything unrecognised stays plain text, including a malformed operator: a subject
 * containing `in:` or a time like `20:30` must still be findable by typing it.
 */

export const SearchFolder = {
  Inbox: "inbox",
  Sent: "sent",
  Filed: "filed",
  All: "all",
} as const;

export interface SearchToken {
  kind: "from" | "to" | "has" | "is" | "in" | "after" | "before" | "subject";
  /** Normalised value, not what was typed: `has:FILES` becomes `attachment`. */
  value: string;
  /**
   * The text as it appeared in the query, kept so a chip can be removed from the string it
   * came out of. Without it, clicking a chip drawn from `has:files` would look for
   * `has:attachment` in a query that never contained it.
   */
  raw: string;
}

export interface SearchIntent {
  /** What is left to run through full-text search, with the operators removed. */
  text: string;
  from?: string;
  to?: string;
  hasAttachment?: boolean;
  hasCode?: boolean;
  /** Tri-state: `is:unread` and `is:read` mean different things from the unread tab. */
  unread?: boolean;
  starred?: boolean;
  /** Overrides the `direction` the view asked for, so `in:sent` works from any tab. */
  direction?: "in" | "out" | "all";
  /** `in:filed` asks for mail a rule moved out of the working list. */
  filedOnly?: boolean;
  /** Inclusive ISO bounds compared against `received_at`. */
  after?: string;
  before?: string;
  tokens: SearchToken[];
  /** Words that must appear in the subject line (C12). */
  subject?: string;
  /** Filter by attachment flavour: pictures or documents (C12). */
  hasImage?: boolean;
  hasPdf?: boolean;
}

const HAS_VALUES: Record<string, "attachment" | "code" | "image" | "pdf"> = {
  attachment: "attachment",
  attachments: "attachment",
  file: "attachment",
  files: "attachment",
  code: "code",
  otp: "code",
  image: "image",
  images: "image",
  picture: "image",
  pdf: "pdf",
  pdfs: "pdf",
};

const IS_VALUES: Record<string, "unread" | "read" | "starred"> = {
  unread: "unread",
  read: "read",
  starred: "starred",
};

const IN_VALUES: Record<string, (typeof SearchFolder)[keyof typeof SearchFolder]> = {
  inbox: SearchFolder.Inbox,
  sent: SearchFolder.Sent,
  filed: SearchFolder.Filed,
  archive: SearchFolder.Filed,
  all: SearchFolder.All,
};

/**
 * `key:"a value"`, then `key:value`, then a quoted phrase, then a word. The operator
 * alternatives come first so a quoted value stays attached to its key instead of being
 * split at the space; keys are letters only, so `20:30` is a time and not an operator.
 */
const SCAN = /([a-zA-Z]+):"([^"]*)"|([a-zA-Z]+):([^\s"]+)|"[^"]*"|\S+/g;

/** `2026-09-01`, or a count of `d`/`w`/`m` back from now. */
function toDate(raw: string, now: Date, endOfDay: boolean): string | null {
  const lower = raw.toLowerCase();
  const rel = /^(\d+)([dwm])$/.exec(lower);
  if (rel) {
    const days = Number(rel[1]) * (rel[2] === "d" ? 1 : rel[2] === "w" ? 7 : 30);
    return new Date(now.getTime() - days * 86_400_000).toISOString();
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(lower);
  if (!iso) return null;
  const day = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  if (Number.isNaN(day.getTime())) return null;
  return endOfDay ? new Date(day.getTime() + 86_399_999).toISOString() : day.toISOString();
}

export function parseSearchQuery(raw: string | undefined, now = new Date()): SearchIntent {
  const intent: SearchIntent = { text: "", tokens: [] };
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return intent;

  const words: string[] = [];
  for (const match of trimmed.matchAll(SCAN)) {
    const [piece, quotedKey, quotedValue, bareKey, bareValue] = match;
    const key = (quotedKey ?? bareKey)?.toLowerCase();
    const value = (quotedValue ?? bareValue ?? "").replace(/^"|"$/g, "").trim();

    // No key, an empty value, or an operator we do not know: it is text, not a filter.
    if (!key || !value) {
      words.push(piece);
      continue;
    }

    switch (key) {
      case "from":
        intent.from = value.toLowerCase();
        intent.tokens.push({ kind: "from", value, raw: piece });
        break;
      case "subject":
        intent.subject = value.toLowerCase();
        intent.tokens.push({ kind: "subject", value, raw: piece });
        break;
      case "to":
        intent.to = value.toLowerCase();
        intent.tokens.push({ kind: "to", value, raw: piece });
        break;
      case "has": {
        const what = HAS_VALUES[value.toLowerCase()];
        if (!what) {
          words.push(piece);
          break;
        }
        if (what === "attachment") intent.hasAttachment = true;
        else if (what === "code") intent.hasCode = true;
        else if (what === "image") intent.hasImage = true;
        else if (what === "pdf") intent.hasPdf = true;
        intent.tokens.push({ kind: "has", value: what, raw: piece });
        break;
      }
      case "is": {
        const what = IS_VALUES[value.toLowerCase()];
        if (!what) {
          words.push(piece);
          break;
        }
        if (what === "unread") intent.unread = true;
        else if (what === "starred") intent.starred = true;
        else intent.unread = false;
        intent.tokens.push({ kind: "is", value: what, raw: piece });
        break;
      }
      case "in": {
        const what = IN_VALUES[value.toLowerCase()];
        if (!what) {
          words.push(piece);
          break;
        }
        if (what === SearchFolder.Sent) intent.direction = "out";
        else if (what === SearchFolder.Inbox) intent.direction = "in";
        else if (what === SearchFolder.All) intent.direction = "all";
        else intent.filedOnly = true;
        intent.tokens.push({ kind: "in", value: what, raw: piece });
        break;
      }
      case "after": {
        const at = toDate(value, now, false);
        if (!at) {
          words.push(piece);
          break;
        }
        intent.after = at;
        intent.tokens.push({ kind: "after", value: at.slice(0, 10), raw: piece });
        break;
      }
      case "before": {
        const at = toDate(value, now, true);
        if (!at) {
          words.push(piece);
          break;
        }
        intent.before = at;
        intent.tokens.push({ kind: "before", value: at.slice(0, 10), raw: piece });
        break;
      }
      default:
        words.push(piece);
    }
  }

  intent.text = words.join(" ").trim();
  return intent;
}

/** Whether the query carries any operator at all — the UI uses this to explain itself. */
export function hasSearchOperators(raw: string | undefined): boolean {
  return !!raw && /(^|\s)(from|to|has|is|in|after|before):/i.test(raw);
}
