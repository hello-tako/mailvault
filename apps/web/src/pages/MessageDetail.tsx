import { withStepUp } from "../lib/passkeys";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, attachmentHref, rawMessageHref } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { useAsync } from "../lib/useAsync";
import { useOutbox } from "../lib/useOutbox";
import { formatBytes, fullTime, senderName } from "../lib/format";
import { t } from "../lib/i18n";
import { MessageHtml } from "../components/MessageHtml";
import { TextBody } from "../components/TextBody";
import { ConfirmDialog, ErrorBanner, Loading, Monogram } from "../components/ui";
import { Composer } from "../components/Composer";
import {
  AuthBanner,
  CodeCard,
  LinkCard,
  sortCodes,
  sortLinks,
} from "../components/mail/MailInsights";
import { DeliveryReport } from "../components/mail/DeliveryReport";
import { UnsubscribeCard, parseUnsubscribe } from "../components/mail/UnsubscribeCard";
import { AuthVerdict, BulkMessageAction, MessageDirection } from "@mailvault/shared";

/**
 * One message, read.
 *
 * The screen is assembled from parts that each answer one question — who sent this and where
 * it landed, what it holds for you (a code, a link, a way out), what happened after it left,
 * and the body — because the order they appear in is the app's argument: the useful thing
 * about a message is usually what it contains for you, not the HTML it arrived in.
 */
export function MessageDetail({
  id,
  pane,
  onClose,
  onRead,
  onOpenMessage,
  onDeleted,
}: {
  id: string;
  /** Rendered inside the inbox's reading pane rather than as its own screen. */
  pane?: boolean;
  onClose?: () => void;
  /** Marks read and lets the list move on, so `j` keeps its rhythm. */
  onRead?: (id: string) => void;
  /** Inside the pane, a thread entry swaps the pane rather than leaving the list. */
  onOpenMessage?: (id: string) => void;
  onDeleted?: () => void;
}) {
  const [remoteImages, setRemoteImages] = useState(false);
  const [showText, setShowText] = useState(false);
  const [revealedUnverifiedId, setRevealedUnverifiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [replying, setReplying] = useState(false);
  const markedRef = useRef<string | null>(null);

  const { data, error, loading, reload } = useAsync(
    () => api.getMessage(id, remoteImages),
    [id, remoteImages],
  );
  /*
   * The conversation, asked for by root rather than by this message: opening any reply
   * has to show the whole thread, including the one you are reading.
   */
  const threadId = data?.threadRootId ?? data?.id ?? null;
  const { data: thread, reload: reloadThread } = useAsync(
    () => (threadId ? api.thread(threadId) : Promise.resolve({ id: "", items: [] })),
    [threadId],
  );
  const outbox = useOutbox();

  /*
   * `r` answers the message on screen. The shortcut lives here rather than in the list
   * because a reply needs this message's identity, and the pane is the only thing that knows
   * which one is open — Escape and the read marks are handled by the list around it.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "r") return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      )
        return;
      if (document.querySelector(".palette, .modal")) return;
      e.preventDefault();
      setReplying(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Opening a message marks it read once per id; ignore failures silently.
  useEffect(() => {
    if (!data || data.isRead || markedRef.current === data.id) return;
    markedRef.current = data.id;
    void api
      .setMessageRead(data.id, true)
      .then(reload)
      .catch(() => {
        /* non-critical */
      });
  }, [data, reload]);

  const codes = useMemo(() => sortCodes(data?.extractedCodes ?? []), [data]);
  const links = useMemo(() => sortLinks(data?.verificationLinks ?? []), [data]);
  const sent = data?.direction === MessageDirection.Out;
  const revealUnverified = revealedUnverifiedId === id;
  // Only authenticated inbound mail may surface extracted codes or verification links by default.
  const hidingSecrets =
    !!data && !sent && data.authVerdict !== AuthVerdict.Trusted && !revealUnverified;
  const canReply =
    !!data?.aliasAddress && outbox.aliases.some((a) => a.address === data.aliasAddress);

  async function toggleRead() {
    if (!data) return;
    const next = !data.isRead;
    // In the pane, reading something is also a request to be shown the next one.
    if (next && onRead) {
      onRead(data.id);
      return;
    }
    await api.setMessageRead(data.id, next).catch(() => undefined);
    reload();
  }

  async function toggleStar() {
    if (!data) return;
    setNotice(null);
    try {
      // The bulk endpoint with one id, rather than a second route for the same flag flip.
      await api.bulkMessages(
        [data.id],
        data.starred ? BulkMessageAction.Unstar : BulkMessageAction.Star,
      );
      reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t("bulk.failed"));
    }
  }

  async function remove() {
    try {
      await withStepUp(() => api.deleteMessage(id));
      onDeleted?.();
      navigate("/inbox");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t("common.deleteFail"));
      setConfirmDelete(false);
    }
  }

  return (
    <div className={pane ? "pane-body" : "page"}>
      {pane ? (
        <div className="pane-bar">
          <span className="eyebrow">{t("msg.body")}</span>
          <button className="ghost small" aria-label={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
      ) : (
        <div className="backrow">
          <Link className="backlink" to="/inbox">
            {t("msg.back")}
          </Link>
        </div>
      )}

      {notice && <div className="banner ok">{notice}</div>}
      {error && <ErrorBanner message={error} />}
      {loading && !data && <Loading />}

      {data && (
        <>
          <div className="card">
            <div className="detail-head">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="subject-head">
                  <Monogram name={senderName(data.headerFrom, data.envelopeFrom)} large />
                  <div style={{ minWidth: 0 }}>
                    <h1 style={{ marginBottom: 6 }}>{data.subject || t("inbox.noSubject")}</h1>
                    <div className="subject-meta">
                      <span className="who">
                        {sent ? t("msg.youSent") : senderName(data.headerFrom, data.envelopeFrom)}
                        {/* Your own alias is not a header worth unpicking; on received mail the
                            address behind the display name is the thing worth reading. */}
                        {!sent && <span className="addr"> · {data.envelopeFrom}</span>}
                      </span>
                      {/* The alias is said once, on the last line. A `To:` that only repeats it
                          is the same address twice on one screen, which is how this header used
                          to read; it stays when it says more than the alias does. */}
                      {data.headerTo && (sent || data.headerTo !== data.aliasAddress) ? (
                        <span>
                          {t("msg.to")} <span className="addr">{data.headerTo}</span>
                        </span>
                      ) : null}
                      <span>
                        {fullTime(data.receivedAt)}
                        {data.aliasLabel ? ` · ${data.aliasLabel}` : ""}{" "}
                        {sent
                          ? t("msg.sentFrom", { address: data.aliasAddress })
                          : t("msg.arrivedAt", { address: data.aliasAddress })}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="row wrap actions-cell">
                <button
                  className="small primary"
                  onClick={() => setReplying(true)}
                  disabled={!canReply}
                  title={canReply ? undefined : t("composer.noAliases")}
                >
                  {t("msg.reply")}
                </button>
                <button className="small" onClick={toggleRead}>
                  {t(data.isRead ? "msg.markUnread" : "msg.markRead")}
                </button>
                <button
                  className="small"
                  aria-pressed={data.starred}
                  onClick={() => void toggleStar()}
                  title={t("msg.starHint")}
                >
                  {t(data.starred ? "msg.unstar" : "msg.star")}
                </button>
                <button className="small" onClick={() => setConfirmDelete(true)}>
                  {t("msg.delete")}
                </button>
                {/* The original bytes as they arrived — a navigation, like attachments. */}
                <button className="small" onClick={() => (window.location.href = rawMessageHref(data.id))}>
                  {t("msg.downloadEml")}
                </button>
              </div>
            </div>
          </div>

          {data.parseDegraded && <div className="banner error mt">{t("msg.degraded")}</div>}

          {/* Our own outgoing mail has no external sender to authenticate: Email Sending
              signs it with this domain's own key, so a verdict banner would only confuse. */}
          {!sent ? <AuthBanner verdict={data.authVerdict} auth={data.auth ?? null} /> : null}

          {!sent && data.listUnsubscribe ? (
            data.authVerdict === AuthVerdict.Trusted ? (
              <UnsubscribeCard
                url={parseUnsubscribe(data.listUnsubscribe).url}
                mailto={parseUnsubscribe(data.listUnsubscribe).mailto}
                oneClick={data.oneClickUnsubscribe}
              />
            ) : (
              <div className="banner mt">
                <span className="muted">{t("msg.unsubscribeHidden")}</span>
              </div>
            )
          ) : null}

          {sent ? (
            <DeliveryReport
              status={data.sendStatus}
              error={data.sendError}
              recipients={data.recipients}
            />
          ) : null}

          {/* Says why this mail is where it is, in the words the rule had at the time —
              so an archive still explains itself after the rule is edited or deleted. */}
          {data.appliedRuleNote && (
            <div className="banner mt">
              <span className="muted">{t("msg.filedAuto", { note: data.appliedRuleNote })}</span>{" "}
              <Link to="/aliases">{t("msg.reviewRules")}</Link>
            </div>
          )}

          {hidingSecrets &&
          (codes.length > 0 ||
            links.length > 0 ||
            data.attachments.length > 0 ||
            data.textBody ||
            data.htmlBody) ? (
            <div className="banner error mt">
              <div>
                <strong>{t("msg.secretsHidden")}</strong>
                {t("msg.secretsHiddenBody")}
              </div>
              <button
                className="small danger"
                style={{ marginTop: 8 }}
                onClick={() => setRevealedUnverifiedId(id)}
              >
                {t("msg.showAnyway", {
                  n: Math.max(1, codes.length + links.length + data.attachments.length),
                })}
              </button>
            </div>
          ) : null}

          {codes.length > 0 && !hidingSecrets && (
            <div className="mt">
              <h2>{t("msg.codes")}</h2>
              <div
                className="grid"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
              >
                {codes.map((c, i) => (
                  <CodeCard key={`${c.value}-${i}`} code={c} />
                ))}
              </div>
            </div>
          )}

          {links.length > 0 && !hidingSecrets && (
            <div className="mt">
              <h2>{t("msg.links")}</h2>
              <div className="stack">
                {links.map((l, i) => (
                  <LinkCard key={`${l.url}-${i}`} link={l} />
                ))}
              </div>
            </div>
          )}

          {!hidingSecrets && data.attachments.length > 0 && (
            <div className="mt">
              <h2>{t("msg.attachments")}</h2>
              <div className="stack">
                {data.attachments.map((a) => (
                  <div key={a.id} className="attach">
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.filename}
                    </span>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {a.contentType} · {formatBytes(a.size)}
                    </span>
                    {/* Authenticated same-origin download; never a public URL. */}
                    <a
                      className="small"
                      href={attachmentHref(data.id, a.id)}
                      rel="noreferrer"
                      style={{ textDecoration: "none" }}
                    >
                      {t("msg.download")}
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!hidingSecrets && (
            <div className="mt">
              <div className="row spread wrap" style={{ marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>{t("msg.body")}</h2>
                <div className="row wrap" style={{ justifyContent: "flex-end", fontSize: 12 }}>
                  {data.htmlBody && (
                    <button className="small ghost" onClick={() => setShowText((s) => !s)}>
                      {t(showText ? "msg.showHtml" : "msg.showPlain")}
                    </button>
                  )}
                  {data.htmlBody && !remoteImages && (
                    <button className="small" onClick={() => setRemoteImages(true)}>
                      {t("msg.loadImages")}
                    </button>
                  )}
                  {remoteImages && (
                    <button className="small ghost" onClick={() => setRemoteImages(false)}>
                      {t("msg.hideImages")}
                    </button>
                  )}
                </div>
              </div>

              {remoteImages && data.htmlBody && (
                <div className="banner" style={{ marginBottom: 10 }}>
                  {t("msg.imagesWarn")}
                </div>
              )}

              {showText || !data.htmlBody ? (
                data.textBody ? (
                  <TextBody text={data.textBody} />
                ) : (
                  <p className="muted">{t("msg.noBody")}</p>
                )
              ) : (
                <MessageHtml html={data.htmlBody} />
              )}
            </div>
          )}
        </>
      )}

      {/*
        The conversation under the message you asked for. A reply that appears somewhere
        else is the failure this removes: the whole exchange, in order, on one screen —
        including your own outgoing answers, which live in the same table.
      */}
      {data && thread && thread.items.length > 1 ? (
        <section className="thread mt">
          <h2 className="thread-title">
            {t("msg.threadTitle")} <span className="faint">{thread.items.length}</span>
          </h2>
          <ol className="thread-list">
            {thread.items.map((m) => {
              const current = m.id === data.id;
              const outgoing = m.direction === MessageDirection.Out;
              const entry = (
                <ThreadEntry
                  outgoing={outgoing}
                  label={
                    outgoing
                      ? `${t("msg.youSent")} → ${m.headerTo || m.aliasAddress}`
                      : senderName(m.headerFrom, m.envelopeFrom)
                  }
                  subject={m.subject}
                  when={m.receivedAt}
                />
              );
              return (
                <li
                  key={m.id}
                  aria-current={current ? "true" : undefined}
                  className={current ? "is-current" : ""}
                >
                  {/* Same content either way; only the gesture differs, and it is the one the
                      surrounding screen can honour — a pane swaps, a page navigates. */}
                  {onOpenMessage ? (
                    <button
                      type="button"
                      className="thread-link"
                      onClick={() => onOpenMessage(m.id)}
                    >
                      {entry}
                    </button>
                  ) : (
                    <Link to={`/messages/${m.id}`} className="thread-link">
                      {entry}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {replying ? (
        <Composer
          replyTo={data}
          sendableAliases={outbox.aliases}
          remaining={outbox.capabilities?.remaining ?? 0}
          bindingMissing={outbox.capabilities?.bindingMissing}
          onClose={() => setReplying(false)}
          onSent={() => {
            setReplying(false);
            reload();
            reloadThread();
            // The day's budget moved with the send, and the composer shows it.
            outbox.reload();
            setNotice(t("msg.replySent"));
          }}
        />
      ) : null}

      {confirmDelete && (
        <ConfirmDialog
          title={t("msg.deleteTitle")}
          confirmLabel={t("msg.deleteConfirm")}
          description={t("msg.deleteBody")}
          onConfirm={remove}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function ThreadEntry({
  outgoing,
  label,
  subject,
  when,
}: {
  outgoing: boolean;
  label: string;
  subject: string | null;
  when: string;
}) {
  return (
    <>
      <span className={`thread-dir ${outgoing ? "out" : ""}`}>{outgoing ? "↗" : "↘"}</span>
      <span className="thread-who">{label}</span>
      <span className="thread-preview">{subject || t("inbox.noSubject")}</span>
      <span className="thread-time faint">{fullTime(when)}</span>
    </>
  );
}
