import type { MessageCounters, MessageListQuery } from "@mailvault/shared";

/**
 * The views a mailbox is read through, and what each one asks the API for.
 *
 * This is a table rather than a chain of conditionals inside the screen because the mapping
 * is the part most likely to be wrong and least likely to be noticed: a tab that quietly
 * shows filed mail, or a Starred tab that also filters to received messages only, both look
 * fine until the day something is missing from a list and cannot be found.
 */

/** `archived` is what the rules file mail into; the tab calls it "Filed" because that is what it is for. */
export type View = "all" | "unread" | "starred" | "archived" | "sent";

export const VIEWS: View[] = ["all", "unread", "starred", "archived", "sent"];

export const VIEW_LABEL: Record<View, string> = {
  all: "inbox.all",
  unread: "inbox.unreadTab",
  starred: "inbox.starredTab",
  archived: "inbox.filed",
  sent: "inbox.sentTab",
};

/**
 * The list request for a view. `threaded` is decided by the caller because it stops being
 * true the moment a search is running, which is a fact about the search rather than the tab.
 */
export function queryFor(
  view: View,
  over: { q?: string; aliasId?: string; domainId?: string; offset: number; limit: number; threaded: boolean; before?: string },
): MessageListQuery {
  return {
    filter: view === "unread" ? "unread" : "all",
    archived: view === "archived" ? "archived" : "active",
    // Sent mail shares the table, so a view says which side of a conversation it shows.
    // Starred spans both: marking a letter you sent is as useful as marking one you got.
    direction: view === "sent" ? "out" : view === "starred" ? "all" : "in",
    starred: view === "starred" ? "true" : undefined,
    q: over.q || undefined,
    aliasId: over.aliasId,
    domainId: over.domainId,
    threaded: over.threaded,
    limit: over.limit,
    offset: over.offset,
    before: over.before,
  };
}

/**
 * The number beside a tab's name, counted over the whole mailbox rather than the page on
 * screen — a badge that changed as you paged would be describing the viewport, not the
 * mailbox. `unread` gets none: the All tab already carries the unread count, and the same
 * number twice on two adjacent tabs reads as two different facts.
 */
export function tabBadge(view: View, c: MessageCounters): number | null {
  if (view === "unread") return null;
  if (view === "all") return c.inbox.unread;
  if (view === "sent") return c.sent.total;
  if (view === "starred") return c.starred.total;
  return c.filed.total;
}
