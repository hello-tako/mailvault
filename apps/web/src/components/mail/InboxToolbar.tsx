import { useMemo } from "react";
import { navigate } from "../../lib/router";
import { t } from "../../lib/i18n";
import { VIEWS, VIEW_LABEL, tabBadge, type View } from "../../lib/mailviews";
import { parseSearchQuery, type MessageCounters } from "@mailvault/shared";

/**
 * The strip that says which mail is on screen: the five views, the mailbox the list is
 * narrowed to, the words filtering it, and the two controls over how the same mail is arranged.
 *
 * The operator chips are read back from the same parser the Worker runs, and each one removes
 * itself from the query it describes. That is the point of showing them at all: a search that
 * silently became narrower is worse than one that plainly returned nothing, because the first
 * teaches the owner to distrust the list.
 */
export function InboxToolbar({
  view,
  onView,
  counters,
  q,
  onQ,
  search,
  onSearch,
  mailboxes,
  domainId,
  aliasId,
  grouped,
  onGrouped,
  onRefresh,
  /** The rail carries the mailbox list on a wide screen; a phone still needs the picker. */
  mailboxPicker,
}: {
  view: View;
  onView: (v: View) => void;
  counters: MessageCounters | null;
  q: string;
  onQ: (next: string) => void;
  search: string;
  onSearch: (next: string) => void;
  mailboxes: { domainId: string; name: string }[];
  domainId?: string;
  aliasId?: string;
  grouped: boolean;
  onGrouped: (next: boolean) => void;
  onRefresh: () => void;
  mailboxPicker: boolean;
}) {
  const intent = useMemo(() => parseSearchQuery(search), [search]);

  function run(value: string) {
    // `q` is the draft and `search` is what is running; this is the only place the draft
    // becomes a query, which is why both setters come from the parent.
    const trimmed = value.trim();
    onQ(trimmed);
    onSearch(trimmed);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(q);
  }

  function removeToken(raw: string) {
    // Literal split/join: an operator value can hold `.` or `+`, which a regex would eat.
    run(q.split(raw).join(" ").replace(/\s{2,}/g, " "));
  }

  return (
    <>
      <form className="toolbar toolbar--sticky" onSubmit={submit}>
        {/* Plain buttons, not `role="tab"`: a tablist promises arrow-key navigation and a
            panel to move between, and this strip does neither — it filters one list. */}
        <div className="tabs" aria-label={t("inbox.title")}>
          {VIEWS.map((v) => {
            const badge = counters ? tabBadge(v, counters) : null;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                className={view === v ? "active" : ""}
                onClick={() => onView(v)}
              >
                {t(VIEW_LABEL[v])}
                {badge ? <span className="tab-count">{badge}</span> : null}
              </button>
            );
          })}
        </div>
        {mailboxPicker && !aliasId && (
          <select
            className="mailbox-select"
            aria-label={t("inbox.mailbox")}
            value={domainId ?? ""}
            onChange={(e) => navigate(e.target.value ? `/inbox?domain=${e.target.value}` : "/inbox")}
          >
            <option value="">{t("inbox.allMailboxes")}</option>
            {/* No unread count in the label: a `select` sizes itself to its longest option, and
                the few extra characters are enough to drop the picker onto a line of its own —
                the third line of filters this screen is measured on avoiding. */}
            {mailboxes.map((m) => (
              <option key={m.domainId} value={m.domainId}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        {/* One field, submitting on its own key: a button that repeats the field's label is a
            second control doing what the keyboard already does, and it cost this line a
            search box narrow enough to hide an operator in it. */}
        <input
          className="search"
          type="search"
          placeholder={t("inbox.placeholder")}
          aria-label={t("common.search")}
          value={q}
          onChange={(e) => onQ(e.target.value)}
        />
        <div className="toolbar-tools">
          {/* A view preference, not a filter: grouping changes how the same messages are
              stacked, so it belongs with the other view control rather than the page title. */}
          <button
            type="button"
            className="ghost small"
            aria-pressed={grouped}
            title={search ? t("inbox.groupOffWhileSearching") : t("inbox.groupHint")}
            onClick={() => onGrouped(!grouped)}
          >
            {t("inbox.groupConversations")}
          </button>
          <button type="button" className="ghost small icon" aria-label={t("common.refresh")} title={t("common.refresh")} onClick={onRefresh}>
            ⟳
          </button>
        </div>
        {aliasId && (
          <button type="button" className="ghost small" onClick={() => navigate("/inbox")}>
            {t("inbox.clearAlias")}
          </button>
        )}
      </form>

      {intent.tokens.length > 0 && (
        <div className="chip-row">
          {intent.tokens.map((tok) => (
            <button key={tok.raw} type="button" className="chip" onClick={() => removeToken(tok.raw)} title={t("search.chipRemove")}>
              <span className="chip-k">{t(`search.op.${tok.kind}`)}</span>
              {tok.value}
              <span aria-hidden="true"> ✕</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
