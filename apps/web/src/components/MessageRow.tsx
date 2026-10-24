import { useEffect, useState } from "react";
import { Link } from "../lib/router";
import { relativeTime, sendPill, senderName } from "../lib/format";
import { arrivalLabel } from "../lib/mailboxes";
import { copyText } from "../lib/clipboard";
import { t } from "../lib/i18n";
import { AuthVerdict, MessageDirection, type MessageSummary } from "@mailvault/shared";

/**
 * One message row, used by the inbox and by the dashboard's recent list. It lives in one
 * file because the dashboard once kept its own copy of the markup and fell out of step
 * with the grid the stylesheet expects — which showed up as a page wider than a phone.
 *
 * The row is one line wide on a desktop and two on a phone, and it carries only what tells
 * mail apart: who, what it says, when, and the few marks that change what opening it means.
 * Everything descriptive about *how* it arrived — the alias it landed on, the verdict's
 * wording, the domain — belongs to the message, because a list of 20 rows repeating
 * `demo.example` twenty times is not information, it is noise with a headcount.
 */

function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={`msg-code mono ${copied ? "is-copied" : ""}`}
      title={copied ? t("common.copied") : t("msg.copyCode")}
      aria-label={t("msg.copyCode")}
      onClick={async (e) => {
        // The row is a link; copying must not also open the message.
        e.preventDefault();
        e.stopPropagation();
        if (await copyText(code)) setCopied(true);
      }}
    >
      {code}
      <span aria-hidden="true">{copied ? " ✓" : " ⧉"}</span>
    </button>
  );
}

export function MsgItem({
  m,
  scoped,
  fresh,
  active,
  wide,
  selected,
  onOpen,
  onSelect,
  onStar,
}: {
  m: MessageSummary;
  scoped: boolean;
  fresh: boolean;
  active: boolean;
  wide: boolean;
  selected?: boolean;
  onOpen: (id: string) => void;
  /**
   * `shift` is the modifier the row was clicked with — a range is only meaningful there.
   * Both handlers are optional because selection and starring are inbox actions: the
   * dashboard's "recent" list shows the same rows without pretending to be a list you work
   * through, so it passes neither and gets neither control.
   */
  onSelect?: (id: string, shift: boolean) => void;
  onStar?: (m: MessageSummary) => void;
}) {
  const sender = senderName(m.headerFrom, m.envelopeFrom);
  const sent = m.direction === MessageDirection.Out;
  const href = wide ? `/inbox?open=${encodeURIComponent(m.id)}` : `/messages/${m.id}`;
  // Inside one mailbox every row arrived at the same place, so the alias is only said where
  // it tells two rows apart.
  const arrival = sent ? null : arrivalLabel(m, scoped);
  // Fail closed, the way main hardened it: anything not provably from the claimed sender —
  // spoofed *or merely unverified* — gets the warning, and its content stays out of the list.
  const unverified = !sent && m.authVerdict !== AuthVerdict.Trusted;
  return (
    <li
      className={`msg ${m.isRead ? "" : "unread"} ${fresh ? "is-live" : ""} ${active ? "is-active" : ""} ${sent ? "is-sent" : ""} ${selected ? "is-selected" : ""} ${onSelect ? "is-selectable" : ""}`}
      data-verdict={m.authVerdict}
      data-msg-id={m.id}
    >
      <div className="msg-row">
        {/* The checkbox is always visible, not revealed on hover like the other row actions:
            a control you cannot find cannot start a selection, and on a touch screen there is
            no hover at all. The placeholder keeps a row without one aligned with its neighbours. */}
        {onSelect ? (
          <label className="msg-check">
            <input
              type="checkbox"
              checked={!!selected}
              onChange={(e) => onSelect(m.id, (e.nativeEvent as MouseEvent).shiftKey)}
              aria-label={t("inbox.selectRow", { subject: m.subject || t("inbox.noSubject") })}
            />
          </label>
        ) : (
          <span className="msg-check" aria-hidden="true" />
        )}
        {/* A star is the one mark the owner makes that no rule can reproduce, so it is the one
            action promoted out of the row menu — and it sits where the eye starts, not where it
            has to hunt. */}
        {onStar ? (
          <button
            type="button"
            className={`star ${m.starred ? "is-on" : ""}`}
            aria-pressed={m.starred}
            aria-label={t(m.starred ? "msg.unstar" : "msg.star")}
            title={t(m.starred ? "msg.unstar" : "msg.star")}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onStar(m);
            }}
          >
            {m.starred ? "★" : "☆"}
          </button>
        ) : (
          <span className="star" aria-hidden="true" />
        )}
        <span className="msg-sender">
          {/* Outgoing mail is addressed *to* somebody; naming the peer as the sender would read
              as "this person wrote to me", so the row says who it went to instead. */}
          {sent ? `${t("msg.toPrefix")} ${m.headerTo || m.aliasAddress}` : sender}
        </span>
        <span className="msg-line">
          {/* The link is the row's text; its ::after stretches over the whole row so the empty
              space is tappable too. */}
          <Link
            to={href}
            className="msg-link"
            onClick={() => {
              if (wide) onOpen(m.id);
            }}
          >
            {m.threadCount && m.threadCount > 1 ? (
              // The badge is the conversation's size, so a row that stands for three messages
              // never reads like a single one.
              <span className="msg-thread-count" title={t("inbox.nInThread", { n: m.threadCount })}>
                {m.threadCount}
              </span>
            ) : null}
            {unverified ? (
              // Never echo an unverified sender's payload in the list — but say plainly that
              // the row is not what it claims. Colour alone would not carry it.
              <span className="msg-warn">{t("inbox.unverified")}</span>
            ) : null}
            <span className="msg-subject">{m.subject || t("inbox.noSubject")}</span>
            {m.preview && (sent || m.authVerdict === AuthVerdict.Trusted) ? <span className="msg-preview">{m.preview}</span> : null}
            {/* Where it arrived, after the words rather than before them: the subject is what a
                row is scanned for, and this is the fact that tells two rows in one list apart —
                the alias inside a mailbox, the mailbox across all of them. It takes its width
                from the preview, which is the least of the three. */}
            {arrival ? (
              <span className="msg-alias" title={t("inbox.arrivedAt")}>
                {arrival}
              </span>
            ) : null}
            {m.ruleTag ? <span className="msg-tag" title={t("inbox.filedTag")}>{m.ruleTag}</span> : null}
            {m.attachmentCount > 0 ? (
              <span className="msg-file" title={t("inbox.nAttachments", { n: m.attachmentCount })}>
                📎{m.attachmentCount}
              </span>
            ) : null}
            {sent && m.sendStatus ? (
              // A word in the status colour, not a pill: the list has to stay one line tall.
              <span className={`msg-state ${sendPill(m.sendStatus)}`}>{t(`send.status.${m.sendStatus}`)}</span>
            ) : null}
            {arrival && !m.preview ? <span className="msg-alias">{arrival}</span> : null}
          </Link>
          {/* Getting the code is this app's main job; opening the message to reach it is a
              round trip the row can skip. Only an authenticated sender's code is shown,
              exactly as main hardened it — unverified is not good enough here. */}
          {m.authVerdict === AuthVerdict.Trusted && !sent && m.primaryCode ? <CodeChip code={m.primaryCode} /> : null}
        </span>
        <span className="msg-time">{relativeTime(m.receivedAt)}</span>
      </div>
    </li>
  );
}
