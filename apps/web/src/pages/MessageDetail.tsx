import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { api, attachmentHref, rawMessageHref } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { useAsync } from "../lib/useAsync";
import { useOutbox } from "../lib/useOutbox";
import { formatBytes, fullTime, senderName } from "../lib/format";
import { htmlHasContent } from "../lib/bodies";
import { insightsOpen } from "../lib/insights";
import { t } from "../lib/i18n";
import { MessageHtml } from "../components/MessageHtml";
import { TextBody } from "../components/TextBody";
import { ConfirmDialog, ErrorBanner, Loading, Menu } from "../components/ui";
import { AuthBanner, AuthDetail, CodeCard, LinkCard, sortCodes, sortLinks } from "../components/mail/MailInsights";
import { Fold } from "../components/mail/Fold";
import { DeliveryReport } from "../components/mail/DeliveryReport";
import { UnsubscribeCard, parseUnsubscribe } from "../components/mail/UnsubscribeCard";
import { AuthVerdict, BulkMessageAction, MessageDirection } from "@mailvault/shared";

// The editor is needed only when a reply starts; the reader should not carry it.
const Composer = lazy(() => import("../components/Composer").then((m) => ({ default: m.Composer })));

/**
 * One message, read.
 *
 * The order on the screen is the argument: what the message says comes before anything that
 * explains it. So — who sent it and when, the verdict about that sender in one line, any code
 * it holds (the reason this mailbox exists), the body, the files, and only then the panels that
 * answer a question the owner sometimes asks: where do these links go, what was checked, did my
 * send arrive. Those fold, and whether they start folded is the owner's choice in Settings.
 */
export function MessageDetail({
  id,
  pane,
  onClose,
  onRead,
  onOpenMessage,
}: {
  id: string;
  /** Rendered inside the inbox's reading pane rather than as its own screen. */
  pane?: boolean;
  onClose?: () => void;
  /** Marks read and lets the list move on, so `j` keeps its rhythm. */
  onRead?: (id: string) => void;
  /** Inside the pane, a thread entry swaps the pane rather than leaving the list. */
  onOpenMessage?: (id: string) => void;
}) {
  const [remoteImages, setRemoteImages] = useState(false);
  const [showText, setShowText] = useState(false);
  const [revealSpoofed, setRevealSpoofed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [replying, setReplying] = useState(false);
  const markedRef = useRef<string | null>(null);

  const { data, error, loading, reload } = useAsync(() => api.getMessage(id, remoteImages), [id, remoteImages]);
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
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      if (document.querySelector(".palette, .modal")) return;
      e.preventDefault();
      setReplying(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Opening a message marks it read once per id; the row's flag moves locally rather than
  // refetching the whole message — the list's badges answer to its own counters call.
  const [readLocal, setReadLocal] = useState<boolean | null>(null);
  const isRead = readLocal ?? data?.isRead ?? false;
  useEffect(() => {
    setReadLocal(null);
  }, [id]);
  useEffect(() => {
    if (!data || data.isRead || markedRef.current === data.id) return;
    markedRef.current = data.id;
    setReadLocal(true);
    void api.setMessageRead(data.id, true).catch(() => {
      /* non-critical */
    });
  }, [data]);

  const codes = useMemo(() => sortCodes(data?.extractedCodes ?? []), [data]);
  const links = useMemo(() => sortLinks(data?.verificationLinks ?? []), [data]);
  // A spoofed message's "code" and "verify link" are the payload a phisher wants read,
  // so they stay hidden until the owner explicitly asks for them.
  const hidingSecrets = !!data && data.authVerdict === AuthVerdict.Spoofed && !revealSpoofed;
  const sent = data?.direction === MessageDirection.Out;
  const canReply = !!data?.aliasAddress && outbox.aliases.some((a) => a.address === data.aliasAddress);
  // Mail stored before authentication existed has nothing to report; saying "not verified"
  // every time would train the owner to ignore the real warning.
  const showAuth = !!data && (!!data.auth || data.authVerdict === AuthVerdict.Spoofed);
  // An HTML part with nothing renderable in it is not a body: the text part answers for it.
  const html = data?.htmlBody && htmlHasContent(data.htmlBody) ? data.htmlBody : null;
  const insights = insightsOpen();

  async function toggleRead() {
    if (!data) return;
    const next = !isRead;
    // In the pane, reading something is also a request to be shown the next one.
    if (next && onRead) {
      onRead(data.id);
      return;
    }
    setReadLocal(next);
    await api.setMessageRead(data.id, next).catch(() => undefined);
  }

  async function toggleStar() {
    if (!data) return;
    setNotice(null);
    try {
      // The bulk endpoint with one id, rather than a second route for the same flag flip.
      await api.bulkMessages([data.id], data.starred ? BulkMessageAction.Unstar : BulkMessageAction.Star);
      reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t("bulk.failed"));
    }
  }

  async function remove() {
    try {
      await api.deleteMessage(id);
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
          {/* No "MESSAGE" label above the subject: the subject is the label, and the pane is
              already inside a screen that says what it is. */}
          <button className="ghost small" aria-label={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
      ) : (
        <div className="backrow">
          <Link className="backlink" to="/inbox">{t("msg.back")}</Link>
        </div>
      )}

      {notice && <div className="banner ok">{notice}</div>}
      {error && <ErrorBanner message={error} />}
      {loading && !data && <Loading />}

      {data && (
        <>
          {/* The message first: who and what it says in two lines, the actions in one row, and
              nothing else on the screen until the body has been read. */}
          <header className="mail-head">
            <h1>{data.subject || t("inbox.noSubject")}</h1>
            <div className="mail-meta">
              <span className="who">{sent ? t("msg.youSent") : senderName(data.headerFrom, data.envelopeFrom)}</span>
              {/* Your own alias is not a header worth unpicking; on received mail the address
                  behind the display name is the thing worth reading. */}
              {!sent && <span className="addr">{data.envelopeFrom}</span>}
              <span>{fullTime(data.receivedAt)}</span>
              {/* The alias is said once. A `To:` that only repeats it is the same address twice
                  on one screen, so it stays only when it says more than the alias does. */}
              <span>
                {sent
                  ? t("msg.sentFrom", { address: data.aliasAddress })
                  : t("msg.arrivedAt", { address: data.aliasAddress })}
                {data.aliasLabel ? ` · ${data.aliasLabel}` : ""}
              </span>
              {data.headerTo && (sent || data.headerTo !== data.aliasAddress) ? (
                <span>
                  {t("msg.to")} <span className="addr">{data.headerTo}</span>
                </span>
              ) : null}
            </div>
            <div className="row wrap mail-actions">
              <button
                className="small primary"
                onClick={() => setReplying(true)}
                disabled={!canReply}
                title={canReply ? undefined : t("composer.noAliases")}
              >
                {t("msg.reply")}
              </button>
              <button className="small" onClick={toggleRead}>
                {t(isRead ? "msg.markUnread" : "msg.markRead")}
              </button>
              <Menu
                small
                label={t("common.more")}
                items={[
                  { label: t(data.starred ? "msg.unstar" : "msg.star"), onSelect: () => void toggleStar() },
                  {
                    label: t("msg.downloadEml"),
                    onSelect: () => {
                      window.location.href = rawMessageHref(data.id);
                    },
                  },
                  { label: t("msg.delete"), onSelect: () => setConfirmDelete(true), danger: true },
                ]}
              />
            </div>
          </header>

          {data.parseDegraded && <div className="banner error mt">{t("msg.degraded")}</div>}

          {/* Our own outgoing mail has no external sender to authenticate: Email Sending signs
              it with this domain's own key, so a verdict banner would only confuse. */}
          {!sent && showAuth ? (
            <div className="mt">
              <AuthBanner verdict={data.authVerdict} />
            </div>
          ) : null}

          {/* Says why this mail is where it is, in the words the rule had at the time — so an
              archive still explains itself after the rule is edited or deleted. */}
          {data.appliedRuleNote && (
            <div className="banner mt">
              <span className="muted">{t("msg.filedAuto", { note: data.appliedRuleNote })}</span>{" "}
              <Link to="/aliases">{t("msg.reviewRules")}</Link>
            </div>
          )}

          {hidingSecrets && (codes.length > 0 || links.length > 0) ? (
            <div className="banner error mt">
              <div>
                <strong>{t("msg.secretsHidden")}</strong>
                {t("msg.secretsHiddenBody")}
              </div>
              <button className="small danger" style={{ marginTop: 8 }} onClick={() => setRevealSpoofed(true)}>
                {t("msg.showAnyway", { n: codes.length + links.length })}
              </button>
            </div>
          ) : null}

          {/* A code is the reason the mailbox exists, so it is neither folded nor sent below
              the body: it is the first thing after the verdict, and one tap from being copied. */}
          {codes.length > 0 && !hidingSecrets && (
            <div className="code-strip mt" role="group" aria-label={t("msg.codes")}>
              {codes.map((c, i) => (
                <CodeCard key={`${c.value}-${i}`} code={c} />
              ))}
            </div>
          )}

          <section className="mail-body mt">
            <div className="row spread wrap body-bar">
              <h2>{t("msg.body")}</h2>
              <div className="row wrap body-tools">
                {html && (
                  <button className="small ghost" onClick={() => setShowText((s) => !s)}>
                    {t(showText ? "msg.showHtml" : "msg.showPlain")}
                  </button>
                )}
                {html && !remoteImages && (
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

            {remoteImages && html && <div className="banner">{t("msg.imagesWarn")}</div>}

            {/* An HTML part with nothing renderable in it is a tall white box, not a message:
                the text part answers for it, and if there is none the screen says so. */}
            {showText || !html ? (
              data.textBody ? (
                <TextBody text={data.textBody} />
              ) : (
                <p className="muted">{t("msg.noBody")}</p>
              )
            ) : (
              <MessageHtml html={html} />
            )}
          </section>

          {data.attachments.length > 0 && (
            <section className="mt">
              <h2>{t("msg.attachments")}</h2>
              <div className="stack">
                {data.attachments.map((a) => (
                  <div key={a.id} className="attach">
                    <span className="file-name">{a.filename}</span>
                    <span className="faint file-size">
                      {a.contentType} · {formatBytes(a.size)}
                    </span>
                    {/* Authenticated same-origin download; never a public URL. */}
                    <a className="small" href={attachmentHref(data.id, a.id)} rel="noreferrer">
                      {t("msg.download")}
                    </a>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Everything that explains the message rather than being it. */}
          {links.length > 0 && !hidingSecrets && (
            <div className="mt">
              <Fold title={t("msg.links")} count={links.length} open={insights}>
                <div className="stack">
                  {links.map((l, i) => (
                    <LinkCard key={`${l.url}-${i}`} link={l} />
                  ))}
                </div>
              </Fold>
            </div>
          )}

          {!sent && data.listUnsubscribe ? (
            data.authVerdict === AuthVerdict.Trusted ? (
              <div className="mt">
                <Fold title={t("msg.unsubscribeTitle")} open={insights}>
                  <UnsubscribeCard
                    url={parseUnsubscribe(data.listUnsubscribe).url}
                    mailto={parseUnsubscribe(data.listUnsubscribe).mailto}
                    oneClick={data.oneClickUnsubscribe}
                  />
                </Fold>
              </div>
            ) : (
              <div className="banner mt">
                <span className="muted">{t("msg.unsubscribeHidden")}</span>
              </div>
            )
          ) : null}

          {sent ? (
            <div className="mt">
              <Fold title={t("msg.deliveryTitle")} count={data.recipients.length} open={insights}>
                <DeliveryReport status={data.sendStatus} error={data.sendError} recipients={data.recipients} />
              </Fold>
            </div>
          ) : null}

          {!sent && showAuth ? (
            <div className="mt">
              <Fold title={t("msg.authTitle")} open={insights}>
                <AuthDetail verdict={data.authVerdict} auth={data.auth ?? null} />
              </Fold>
            </div>
          ) : null}
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
                <li key={m.id} aria-current={current ? "true" : undefined} className={current ? "is-current" : ""}>
                  {/* Same content either way; only the gesture differs, and it is the one the
                      surrounding screen can honour — a pane swaps, a page navigates. */}
                  {onOpenMessage ? (
                    <button type="button" className="thread-link" onClick={() => onOpenMessage(m.id)}>
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
        <Suspense fallback={null}>
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
        </Suspense>
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
