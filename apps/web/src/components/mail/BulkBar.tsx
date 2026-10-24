import { t } from "../../lib/i18n";
import { BulkMessageAction } from "@mailvault/shared";
import type { View } from "../../lib/mailviews";

/**
 * The list's head row: the master checkbox, and the actions a selection can take.
 *
 * The actions exist only while a selection does. Five buttons above an untouched list were
 * asking what to do before there was anything to do with, and they cost the row of mail that
 * would otherwise start there. It sits at the head of the list rather than floating over it,
 * because a bar that covers the first two messages hides exactly the rows being decided about.
 * On a phone it is not drawn at all until something is selected — there, the first rows of
 * mail are worth more than the promise of a control used occasionally.
 */
export function BulkBar({
  count,
  allSelected,
  someSelected,
  busy,
  view,
  onToggleAll,
  onAction,
  onDelete,
}: {
  count: number;
  allSelected: boolean;
  someSelected: boolean;
  busy: boolean;
  view: View;
  onToggleAll: () => void;
  onAction: (action: BulkMessageAction) => void;
  onDelete: () => void;
}) {
  const empty = count === 0;
  const actions: { action: BulkMessageAction; label: string; danger?: boolean }[] = [
    { action: BulkMessageAction.Read, label: "bulk.read" },
    { action: BulkMessageAction.Unread, label: "bulk.unread" },
    { action: BulkMessageAction.Star, label: "bulk.star" },
    // The same control means the opposite thing in the Filed view, and says so.
    view === "archived"
      ? { action: BulkMessageAction.Unarchive, label: "bulk.unarchive" }
      : { action: BulkMessageAction.Archive, label: "bulk.archive" },
    { action: BulkMessageAction.Delete, label: "bulk.delete", danger: true },
  ];

  return (
    <div className={`bulkbar${empty ? " is-idle" : ""}`} role="toolbar" aria-label={t("bulk.actions")}>
      <span className="bulk-all">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={onToggleAll}
          ref={(el) => {
            // `indeterminate` is a property with no attribute equivalent; the ref is the only
            // way to say "some of this page" to a screen reader.
            if (el) el.indeterminate = someSelected && !allSelected;
          }}
          aria-label={t("inbox.selectAllPage")}
        />
      </span>
      <span className="bulk-count">{empty ? t("inbox.selectAllHint") : t("bulk.nSelected", { n: count })}</span>
      {!empty && (
        <div className="bulk-actions">
          {actions.map(({ action, label, danger }) => (
            <button
              key={action}
              type="button"
              className={`small${danger ? " danger" : ""}`}
              disabled={busy}
              onClick={() => (action === BulkMessageAction.Delete ? onDelete() : onAction(action))}
            >
              {t(label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
