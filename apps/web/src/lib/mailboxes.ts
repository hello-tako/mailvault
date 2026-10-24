import { MailStatus, type MailboxStat, type MessageSummary } from "@mailvault/shared";

/**
 * How many mailboxes are laid out before the rest collapse behind a count. Six fills a
 * phone screen's worth of two-column cards and still leaves the recent-mail list
 * discoverable without scrolling — the point of the dashboard is to answer "where is my
 * mail", not to enumerate every domain ever synced.
 */
export const MAILBOX_LIMIT = 6;

export interface MailboxSplit {
  /** Busiest first — the API already orders by unread, then volume, then name. */
  shown: MailboxStat[];
  /** Also carrying mail, but past the limit. */
  overflow: MailboxStat[];
  /** Nothing has ever arrived at these. */
  empty: MailboxStat[];
}

export function splitMailboxes(all: MailboxStat[], limit = MAILBOX_LIMIT): MailboxSplit {
  const withMail = all.filter((m) => m.total > 0);
  return {
    shown: withMail.slice(0, limit),
    overflow: withMail.slice(limit),
    empty: all.filter((m) => m.total === 0),
  };
}

/**
 * Mailboxes offered in the inbox switcher. A domain that is not `READY` cannot receive
 * mail, so offering it as a mailbox would only produce an empty list and a mystery —
 * unless the owner is already looking at it, in which case hiding it would break the
 * back gesture out of that view.
 */
export function selectableMailboxes<T extends { domainId: string; mailStatus: string }>(
  all: T[],
  currentId?: string,
): T[] {
  return all.filter((m) => m.mailStatus === MailStatus.Ready || m.domainId === currentId);
}

/**
 * Where a message arrived, phrased for the row. The domain is what separates one mailbox
 * from another, so it leads: a row whose tail is ellipsized then still says which mailbox it
 * belongs to, which is the question the mixed list is asking. Inside one mailbox the domain is
 * what was filtered on, so only the alias is said — and a bare address already carries both.
 */
export function arrivalLabel(
  m: Pick<MessageSummary, "aliasLabel" | "aliasAddress" | "domainName">,
  scoped: boolean,
): string {
  if (!m.aliasLabel) return m.aliasAddress;
  return scoped ? m.aliasLabel : `${m.domainName} · ${m.aliasLabel}`;
}
