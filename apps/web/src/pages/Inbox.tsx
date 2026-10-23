import { withStepUp } from "../lib/passkeys";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { navigate, useRoute } from "../lib/router";
import { useAsync } from "../lib/useAsync";
import { useOutbox } from "../lib/useOutbox";
import { useSelection } from "../lib/useSelection";
import { queryFor, type View } from "../lib/mailviews";
import { selectableMailboxes } from "../lib/mailboxes";
import { useMediaQuery } from "../lib/useMediaQuery";
import { NEW_MAIL_EVENT } from "../lib/live";
import { t } from "../lib/i18n";
import { ConfirmDialog, EmptyState, ErrorBanner, SkeletonList } from "../components/ui";
import { MsgItem } from "../components/MessageRow";
import { BulkBar } from "../components/mail/BulkBar";
import { InboxToolbar } from "../components/mail/InboxToolbar";
import { BulkMessageAction, type MessageSummary } from "@mailvault/shared";

// The pane's heavy parts — the reader and the composer — arrive on demand: the list is
// what every visit opens on, and it should not carry the editor it may never need.
const MessageDetail = lazy(() => import("./MessageDetail").then((m) => ({ default: m.MessageDetail })));
const Composer = lazy(() => import("../components/Composer").then((m) => ({ default: m.Composer })));

const PAGE = 50;

/**
 * The mailbox: a list of messages on the left, the message itself on the right.
 *
 * What is on screen is decided in three places that each own one of them — the view (which
 * mail), the search (which words), the mailbox (which domain) — and the row that opens the
 * pane is a URL parameter rather than component state, so a link to a message works from the
 * palette, a notification, or another tab.
 */
export function Inbox({ aliasId, domainId }: { aliasId?: string; domainId?: string }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("all");
  // Paging is two modes over one pair of states. The plain list pages by keyset cursor
  // (each entry remembers where its page starts and how many rows came before it, so
  // "Newer" pops and the from/to line stays honest); a search or a threaded view ranks
  // and partitions rows, so those keep offset pages exactly as before.
  const [pages, setPages] = useState<{ cursor: string | null; shown: number }[]>([{ cursor: null, shown: 0 }]);
  const [offset, setOffset] = useState(0);
  const [composing, setComposing] = useState(false);
  // Conversation view is the way a mailbox reads; a search opts out, because matching one
  // message and showing a thread is a different question.
  const [grouped, setGrouped] = useState(() => localStorage.getItem("mailvault-threaded") !== "0");
  const [busy, setBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { query: route } = useRoute();
  const wide = useMediaQuery("(min-width: 900px)");
  const openId = wide ? route.get("open") : null;

  const cursorMode = !search && !grouped;
  const page = pages[pages.length - 1]!;

  const query = useMemo(
    () =>
      queryFor(view, {
        q: search,
        aliasId,
        domainId,
        offset: cursorMode ? 0 : offset,
        before: cursorMode ? (page.cursor ?? undefined) : undefined,
        limit: PAGE,
        threaded: grouped && !search,
      }),
    [view, search, aliasId, domainId, offset, grouped, cursorMode, page.cursor],
  );

  // The nudge is news about this list, so this is the one hook on the page that listens;
  // the badges follow from the refetch, and everything else stays where it was.
  const { data, error, loading, reload } = useAsync(() => api.listMessages(query), [query], { live: true });
  const { data: counters, reload: reloadCounters } = useAsync(() => api.messageCounters(domainId), [domainId]);
  // The installed app wears the unread count on its own icon. Where the browser does not
  // support badges the call is simply absent, and nothing here waits on it.
  useEffect(() => {
    if (!counters) return;
    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const op =
      counters.inbox.unread > 0 ? nav.setAppBadge?.(counters.inbox.unread) : nav.clearAppBadge?.();
    if (op && typeof op.catch === "function") op.catch(() => undefined);
  }, [counters]);

  const outbox = useOutbox();
  // The rail carries the mailbox list on a wide screen, so the page only asks for the domains
  // its own phone picker is going to draw.
  const domains = useAsync(() => (wide ? Promise.resolve(null) : api.listDomains()), [wide]);

  const mailboxes = useMemo(
    () =>
      selectableMailboxes(
        (domains.data?.items ?? []).map((d) => ({
          domainId: d.id,
          name: d.name,
          mailStatus: d.mailStatus,
        })),
        domainId,
      ),
    [domains.data, domainId],
  );

  useEffect(() => {
    setOffset(0);
    setPages([{ cursor: null, shown: 0 }]);
  }, [view, search, aliasId, domainId]);

  // Flags the owner just moved show the move at once; the server's answer replaces the
  // guess on the next refetch, and a failed call puts the row back by never confirming.
  const [flagOverrides, setFlagOverrides] = useState<Record<string, { isRead?: boolean; starred?: boolean }>>({});
  const items = useMemo(() => {
    const raw = data?.items ?? [];
    const merged =
      Object.keys(flagOverrides).length === 0 ? raw : raw.map((m) => (flagOverrides[m.id] ? { ...m, ...flagOverrides[m.id] } : m));
    // A tab whose filter is the flag itself (Unread, Starred) must honour the move too:
    // un-starring inside Starred takes the row away now, not at the next refetch.
    if (view === "unread") return merged.filter((m) => !m.isRead);
    if (view === "starred") return merged.filter((m) => m.starred);
    return merged;
  }, [data, flagOverrides, view]);
  const orderedIds = useMemo(() => items.map((m) => m.id), [items]);
  const selection = useSelection(orderedIds);

  // A different list of rows is a different selection: keeping ids that are no longer on
  // screen would let an invisible message be deleted by the next button press. The same
  // change retires any flag guess that belonged to the old page.
  useEffect(() => {
    selection.clear();
    setFlagOverrides({});
  }, [query]);

  const openMessage = useCallback(
    (id: string | null) => {
      const sp = new URLSearchParams(route.toString());
      if (id) sp.set("open", id);
      else sp.delete("open");
      const qs = sp.toString();
      navigate(`/inbox${qs ? `?${qs}` : ""}`);
    },
    [route],
  );

  /*
   * The nudge carries no content, so it cannot say *which* row is new — the refetch it
   * triggers can. Diffing the ids that arrive after a nudge is what lets exactly those rows
   * light up once, instead of flashing the whole list.
   */
  const armed = useRef(false);
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const onNewMail = () => {
      armed.current = true;
    };
    window.addEventListener(NEW_MAIL_EVENT, onNewMail);
    return () => window.removeEventListener(NEW_MAIL_EVENT, onNewMail);
  }, []);

  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.items.map((m) => m.id));
    const wasArmed = armed.current;
    const previous = known.current;
    armed.current = false;
    known.current = ids;
    // The badges count the whole mailbox, so anything that just changed the list may have
    // changed them too — reading, filing and arriving all move a number.
    reloadCounters();
    if (!wasArmed || !previous) return;
    const arrived = [...ids].filter((id) => !previous.has(id));
    if (arrived.length === 0) return;
    setFresh(new Set(arrived));
    const timer = setTimeout(() => setFresh(new Set()), 1700);
    return () => clearTimeout(timer);
  }, [data, reloadCounters]);

  const runBulk = useCallback(
    async (action: BulkMessageAction) => {
      if (selection.count === 0 || busy) return;
      setBusy(true);
      setBulkError(null);
      // Read and star say so immediately on the rows in front of the owner; the actions
      // that move rows between lists still wait for the list itself to answer.
      if (action === BulkMessageAction.Read || action === BulkMessageAction.Unread) {
        const isRead = action === BulkMessageAction.Read;
        setFlagOverrides((prev) => {
          const next = { ...prev };
          for (const id of selection.ids) next[id] = { ...next[id], isRead };
          return next;
        });
      } else if (action === BulkMessageAction.Star || action === BulkMessageAction.Unstar) {
        const starred = action === BulkMessageAction.Star;
        setFlagOverrides((prev) => {
          const next = { ...prev };
          for (const id of selection.ids) next[id] = { ...next[id], starred };
          return next;
        });
      }
      try {
        await (action === BulkMessageAction.Delete
          ? withStepUp(() => api.bulkMessages(selection.ids, action))
          : api.bulkMessages(selection.ids, action));
        selection.clear();
        setConfirmDelete(false);
        reloadCounters();
        if (
          action === BulkMessageAction.Delete ||
          action === BulkMessageAction.Archive ||
          action === BulkMessageAction.Unarchive
        ) {
          reload();
        }
      } catch (e) {
        setFlagOverrides({});
        setBulkError(e instanceof Error ? e.message : t("bulk.failed"));
      } finally {
        setBusy(false);
      }
    },
    [selection, busy, reload, reloadCounters],
  );

  const toggleStar = useCallback(
    async (m: MessageSummary) => {
      setBulkError(null);
      const starred = !m.starred;
      setFlagOverrides((prev) => ({ ...prev, [m.id]: { ...prev[m.id], starred } }));
      try {
        await api.bulkMessages([m.id], starred ? BulkMessageAction.Star : BulkMessageAction.Unstar);
        reloadCounters();
      } catch (e) {
        setFlagOverrides((prev) => {
          const { [m.id]: _dropped, ...rest } = prev;
          return rest;
        });
        setBulkError(e instanceof Error ? e.message : t("bulk.failed"));
      }
    },
    [reloadCounters],
  );

  const step = useCallback(
    (from: number, dir: 1 | -1) => {
      // j/k walk unread first from where you are, then wrap into the rest.
      const order = items.map((_, i) => i);
      const forward = dir === 1 ? order : [...order].reverse();
      const start = dir === 1 ? from + 1 : from - 1;
      const candidates = forward.filter((i) => (dir === 1 ? i > start - 1 : i < start + 1));
      const nextUnread = candidates.find((i) => !items[i]?.isRead);
      const idx =
        nextUnread ?? candidates.find((i) => items[i]) ?? (dir === 1 ? 0 : items.length - 1);
      const target = items[idx];
      if (target) openMessage(target.id);
    },
    [items, openMessage],
  );

  const markRead = useCallback(
    async (id: string, isRead: boolean, advance: boolean) => {
      setFlagOverrides((prev) => ({ ...prev, [id]: { ...prev[id], isRead } }));
      await api.setMessageRead(id, isRead).catch(() => undefined);
      reloadCounters();
      // Reading something and having to hunt for the next one is the friction split
      // inboxes exist to remove.
      const idx = items.findIndex((m) => m.id === id);
      if (advance && isRead && items.length > 1) step(idx, 1);
    },
    [items, reloadCounters, step],
  );

  useEffect(() => {
    if (!wide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector(".palette, .modal")) return;
      // A selection is the thing being worked on, so Escape clears it before anything else:
      // focus sits in the checkbox that made the selection, and a key handler that gave up on
      // any focused input would leave Escape doing nothing exactly when it is most wanted.
      if (e.key === "Escape" && selection.count > 0) {
        e.preventDefault();
        selection.clear();
        return;
      }
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      )
        return;
      if (items.length === 0) return;
      const idx = items.findIndex((m) => m.id === openId);
      const key = e.key.toLowerCase();
      if (key === "j" || key === "k") {
        e.preventDefault();
        step(idx, key === "j" ? 1 : -1);
        return;
      }
      if (e.key === "Escape" && openId) {
        e.preventDefault();
        openMessage(null);
        return;
      }
      if (key === "c") {
        e.preventDefault();
        setComposing(true);
        return;
      }
      // `x` and `s` act on the message on screen, the same two keys a desktop client uses.
      if ((key === "x" || key === "s") && openId) {
        e.preventDefault();
        if (key === "x") selection.toggle(openId);
        else {
          const current = items.find((m) => m.id === openId);
          if (current) void toggleStar(current);
        }
        return;
      }
      if ((key === "e" || key === "u") && openId) {
        e.preventDefault();
        const current = items.find((m) => m.id === openId);
        if (current) void markRead(openId, key === "e" ? true : !current.isRead, key === "e");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide, items, openId, step, openMessage, markRead, selection, toggleStar]);

  useEffect(() => {
    if (!openId) return;
    document.querySelector(`[data-msg-id="${openId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [openId]);

  const total = data?.total ?? 0;
  const hasPrev = cursorMode ? pages.length > 1 : offset > 0;
  const hasNext = cursorMode ? !!data?.nextCursor : data ? offset + PAGE < total : false;

  const scope = aliasId || domainId || search || view !== "all";
  // Inside one mailbox every row arrived at the same domain, so repeating it would be
  // noise; across all of them it is the one fact that tells the rows apart.
  const scoped = !!(aliasId || domainId);

  const list = (
    <>
      {loading && !data && <SkeletonList rows={6} />}

      {data && data.items.length === 0 && (
        <EmptyState
          art={scope ? "search" : "mailbox"}
          title={t(scope ? "inbox.noMatch" : "inbox.empty")}
          hint={t(scope ? "inbox.filterHint" : "inbox.emptyHint")}
          action={
            scope ? (
              <button className="small" onClick={() => navigate("/inbox")}>
                {t("inbox.clearFilters")}
              </button>
            ) : (
              <button className="primary" onClick={() => navigate("/aliases?new=1")}>
                {t("dash.newAlias")}
              </button>
            )
          }
        />
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="card card--flush">
            {/* On a phone the bar appears with the selection instead of sitting above the
                list waiting for it: the first rows of mail are worth more than the promise
                of a control that is only used occasionally. */}
            {wide || selection.count > 0 ? (
              <BulkBar
                count={selection.count}
                allSelected={selection.allSelected}
                someSelected={selection.count > 0}
                busy={busy}
                view={view}
                onToggleAll={selection.toggleAll}
                onAction={(action) => void runBulk(action)}
                onDelete={() => setConfirmDelete(true)}
              />
            ) : null}
            <ul className="msglist">
              {items.map((m) => (
                <MsgItem
                  key={m.id}
                  m={m}
                  scoped={scoped}
                  fresh={fresh.has(m.id)}
                  active={m.id === openId}
                  wide={wide}
                  selected={selection.has(m.id)}
                  onOpen={openMessage}
                  onSelect={selection.toggle}
                  onStar={(row) => void toggleStar(row)}
                />
              ))}
            </ul>
          </div>
          <div className="pager">
            <span className="faint" style={{ fontSize: 13 }}>
              {t("inbox.showing", {
                from: cursorMode ? page.shown + 1 : offset + 1,
                to: cursorMode ? page.shown + items.length : Math.min(offset + PAGE, total),
                total,
              })}
            </span>
            <div className="row">
              <button
                className="small"
                disabled={!hasPrev}
                onClick={() =>
                  cursorMode ? setPages(pages.slice(0, -1)) : setOffset(Math.max(0, offset - PAGE))
                }
              >
                {t("inbox.newer")}
              </button>
              <button
                className="small"
                disabled={!hasNext}
                onClick={() => {
                  if (!cursorMode) setOffset(offset + PAGE);
                  else if (data?.nextCursor)
                    setPages([...pages, { cursor: data.nextCursor, shown: page.shown + items.length }]);
                }}
              >
                {t("inbox.older")}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );

  return (
    <div className="page">
      <div className="page-head">
        {/* The title says what the screen is, and one button says what to do here. The rest of
            the controls belong to the list they act on, so they sit with it. */}
        <h1>{t("inbox.title")}</h1>
        <div className="actions">
          {/* Reachable even when the server cannot send: a control that is simply greyed out
              tells nobody why, and the composer states the reason in its own words. */}
          <button
            className="primary small"
            onClick={() => setComposing(true)}
            disabled={outbox.aliases.length === 0}
            title={outbox.aliases.length === 0 ? t("composer.noAliases") : undefined}
          >
            {t("inbox.compose")}
          </button>
        </div>
      </div>

      {composing && (
        <Suspense fallback={null}>
          <Composer
            sendableAliases={outbox.aliases}
            remaining={outbox.capabilities?.remaining ?? 0}
            bindingMissing={outbox.capabilities?.bindingMissing}
            onClose={() => setComposing(false)}
            onSent={(outcome) => {
              setComposing(false);
              setView("sent");
              reload();
              outbox.reload();
              // The row is the receipt: opening it shows exactly what was sent, so the owner
              // never has to trust a toast that disappears.
              if (wide) openMessage(outcome.id);
            }}
          />
        </Suspense>
      )}

      {error && <ErrorBanner message={error} />}
      {bulkError && <ErrorBanner message={bulkError} />}

      <InboxToolbar
        view={view}
        onView={setView}
        counters={counters}
        q={q}
        onQ={setQ}
        search={search}
        onSearch={setSearch}
        mailboxes={mailboxes}
        domainId={domainId}
        aliasId={aliasId}
        grouped={grouped}
        onGrouped={(next) => {
          setGrouped(next);
          localStorage.setItem("mailvault-threaded", next ? "1" : "0");
        }}
        onRefresh={reload}
        mailboxPicker={!wide}
      />

      {wide && openId ? (
        <div className="mail-split">
          <div className="mail-list">{list}</div>
          <div className="mail-pane" key={openId}>
            <Suspense fallback={null}>
              <MessageDetail
                id={openId}
                pane
                onClose={() => openMessage(null)}
                onOpenMessage={openMessage}
                onRead={(id) => void markRead(id, true, true)}
              />
            </Suspense>
          </div>
        </div>
      ) : (
        list
      )}

      {confirmDelete && selection.count > 0 && (
        <ConfirmDialog
          title={t("bulk.deleteTitle", { n: selection.count })}
          confirmLabel={t("bulk.deleteConfirm", { n: selection.count })}
          description={t("bulk.deleteBody")}
          onConfirm={() => void runBulk(BulkMessageAction.Delete)}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
