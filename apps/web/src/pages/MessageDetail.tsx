import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { withStepUp } from "../lib/passkeys";
import { api, attachmentHref, rawMessageHref } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { useAsync } from "../lib/useAsync";
import { useOutbox } from "../lib/useOutbox";
import { formatBytes, fullTime, senderName } from "../lib/format";
import { htmlHasContent } from "../lib/bodies";
import { insightsOpen } from "../lib/insights";
import { t, lang } from "../lib/i18n";
import { MessageHtml } from "../components/MessageHtml";
import { TextBody } from "../components/TextBody";
import { ConfirmDialog, ErrorBanner, Loading, Menu } from "../components/ui";
import { AuthBanner, AuthDetail, CodeCard, LinkCard, sortCodes, sortLinks } from "../components/mail/MailInsights";
import { Fold } from "../components/mail/Fold";
import { DeliveryReport } from "../components/mail/DeliveryReport";
import { UnsubscribeCard, parseUnsubscribe } from "../components/mail/UnsubscribeCard";
import { AuthVerdict, BulkMessageAction, MessageDirection, SendStatus } from "@mailvault/shared";

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
  /** A delete from the pane must also leave the list, or the row outlives the mail. */
  onDeleted?: () => void;
}) {
  const [remoteImages, setRemoteImages] = useState(false);
  const [showText, setShowText] = useState(false);
  // Keyed by message id: an explicit "show anyway" must not follow the owner into the next
  // unverified message, where the same click would hand a phisher the payload for free.
  const [revealedUnverifiedId, setRevealedUnverifiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmResend, setConfirmResend] = useState(false);
  const [replying, setReplying] = useState(false);
  const [replyAllCcValue, setReplyAllCcValue] = useState("");
  const [forwarding, setForwarding] = useState(false);
  // C11: one translation at a time, for this reader only. C7: the raw header block,
  // fetched from the .eml itself when asked for. C6: three text sizes, remembered.
  const [translated, setTranslated] = useState<{ to: string; text: string } | null>(null);
  const [translating, setTranslating] = useState(false);
  const [headers, setHeaders] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(() => Number(localStorage.getItem("mailvault-zoom") ?? 1));
  const [threadExcerpts, setThreadExcerpts] = useState<Record<string, string>>({});
  const markedRef = useRef<string | null>(null);

  const { data, error, loading, reload } = useAsync(() => api.getMessage(id, remoteImages), [id, remoteImages]);
  // The sender's domain, lowercase, is the mute scope — one noisy sender, one switch.
  const senderDomain = (data?.envelopeFrom ?? "").split("@")[1]?.toLowerCase() ?? "";
  const { data: notifPrefs, reload: reloadNotifPrefs } = useAsync(
    () => api.listNotificationPrefs(),
    [],
  );
  const senderMuted =
    !!senderDomain &&
    !!notifPrefs?.items.some(
      (p) => p.scopeType === "sender_domain" && p.scopeValue === senderDomain && p.action === "mute",
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
      const key = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (key !== "r" && key !== "f") return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      if (document.querySelector(".palette, .modal")) return;
      e.preventDefault();
      if (key === "f") setForwarding(true);
      else setReplying(true);
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
  const sent = data?.direction === MessageDirection.Out;
  // Only authenticated inbound mail may surface extracted codes, verification links, files
  // or the body by default: anything short of TRUSTED keeps its payload behind an explicit
  // "show anyway", because a forged code or link is exactly what a phisher wants read.
  const hidingSecrets =
    !!data && !sent && data.authVerdict !== AuthVerdict.Trusted && revealedUnverifiedId !== id;
  // Reply-all (C8): everyone this message named, minus ourselves — the composer's To stays
  // the sender, exactly as a plain reply, and this line becomes the copy line.
  const replyAllCc = useMemo(() => {
    if (!data || sent) return "";
    const own = data.aliasAddress.toLowerCase();
    const addrs = `${data.headerTo ?? ""}, ${data.cc ?? ""}`
      .split(/[,\s]+/)
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.includes("@") && a !== own && a !== (data.envelopeFrom ?? "").toLowerCase());
    return [...new Set(addrs)].join(", ");
  }, [data, sent]);
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

  async function resend() {
    try {
      // The failed attempt stays as history; the send again is a new row in this thread
      // with the same text and files, re-read from the vault by the Worker (B5).
      await api.resendMessage(id);
      setNotice(t("msg.resent"));
      setConfirmResend(false);
      reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t("common.deleteFail"));
      setConfirmResend(false);
    }
  }

  async function remove() {
    try {
      // Deleting the only copy is irreversible, so it carries the passkey step-up the rest
      // of the irreversible surface requires — sign-in alone must not authorize it.
      await withStepUp(() => api.deleteMessage(id));
      if (pane && onClose) onClose();
      onDeleted?.();
      if (!pane) navigate("/inbox");
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
              {replyAllCc ? (
                <button
                  className="small"
                  onClick={() => {
                    setReplyAllCcValue(replyAllCc);
                    setReplying(true);
                  }}
                >
                  {t("msg.replyAll")}
                </button>
              ) : null}
              <Menu
                small
                label={t("common.more")}
                items={[
                  { label: t("msg.forward"), onSelect: () => setForwarding(true) },
                  { label: t("msg.print"), onSelect: () => window.print() },
                  !sent
                    ? {
                        label: t("msg.translate"),
                        onSelect: () => {
                          if (translating) return;
                          setTranslating(true);
                          void api
                            .translateMessage(id, lang() === "vi" ? "en" : "vi")
                            .then(setTranslated)
                            .catch(() => undefined)
                            .finally(() => setTranslating(false));
                        },
                      }
                    : null,
                  !sent && !headers
                    ? {
                        label: t("msg.fullHeaders"),
                        onSelect: () => {
                          void fetch(rawMessageHref(id))
                            .then((r) => r.text())
                            .then((raw) => setHeaders(raw.slice(0, raw.indexOf("\r\n\r\n") > 0 ? raw.indexOf("\r\n\r\n") : 4000)))
                            .catch(() => setHeaders(null));
                        },
                      }
                    : null,
                  senderDomain
                    ? {
                        label: t("msg.blockSender"),
                        onSelect: () => {
                          void api
                            .createRule({
                              match: { senderDomain },
                              action: { archive: true, tag: "Blocked" },
                            })
                            .then(() => setNotice(t("msg.blocked")))
                            .catch(() => undefined);
                        },
                      }
                    : null,
                  ...(!sent && data.envelopeFrom
                    ? [
                        {
                          label: t("msg.saveContact"),
                          onSelect: () => {
                            void api
                              .saveContact({
                                address: data.envelopeFrom,
                                name: senderName(data.headerFrom, data.envelopeFrom),
                              })
                              .then(() => setNotice(t("msg.contactSaved")))
                              .catch(() => undefined);
                          },
                        },
                      ]
                    : []),
                  ...(senderDomain
                    ? [
                        {
                          label: t(senderMuted ? "msg.unmuteSender" : "msg.muteSender"),
                          onSelect: () => {
                            void api
                              .setNotificationPref({
                                scopeType: "sender_domain",
                                scopeValue: senderDomain,
                                action: senderMuted ? "all" : "mute",
                              })
                              .then(reloadNotifPrefs);
                          },
                        },
                      ]
                    : []),
                  { label: t(data.starred ? "msg.unstar" : "msg.star"), onSelect: () => void toggleStar() },
                  {
                    label: t("msg.downloadEml"),
                    onSelect: () => {
                      window.location.href = rawMessageHref(data.id);
                    },
                  },
                  { label: t("msg.delete"), onSelect: () => setConfirmDelete(true), danger: true },
                ].filter(Boolean as never)}
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

          {!hidingSecrets && (
          <section className="mail-body mt" style={{ fontSize: [14, 15, 17][zoom] }}>
            <div className="row spread wrap body-bar">
              <h2>{t("msg.body")}</h2>
              <div className="row wrap body-tools">
                <button
                  className="small ghost"
                  aria-label={t("msg.zoomOut")}
                  disabled={zoom === 0}
                  onClick={() => {
                    const next = Math.max(0, zoom - 1);
                    setZoom(next);
                    localStorage.setItem("mailvault-zoom", String(next));
                  }}
                >
                  A−
                </button>
                <button
                  className="small ghost"
                  aria-label={t("msg.zoomIn")}
                  disabled={zoom === 2}
                  onClick={() => {
                    const next = Math.min(2, zoom + 1);
                    setZoom(next);
                    localStorage.setItem("mailvault-zoom", String(next));
                  }}
                >
                  A+
                </button>
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
          )}

          {!hidingSecrets && data.attachments.length > 0 && (
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
                    {a.contentType.startsWith("image/") ? (
                      <a
                        className="small"
                        href={`${attachmentHref(data.id, a.id)}?inline=1`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("msg.viewImage")}
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* C11: the translation lives under the body it answers, for this reader only. */}
          {translated ? (
            <div className="mt">
              <Fold title={t("msg.translated")} open>
                <div className="text-body" style={{ whiteSpace: "pre-wrap" }}>{translated.text}</div>
              </Fold>
            </div>
          ) : null}
          {translating ? <p className="faint mt">{t("msg.translating")}</p> : null}

          {/* C7: the untouched header block, straight from the stored .eml. */}
          {headers ? (
            <div className="mt">
              <Fold title={t("msg.fullHeaders")} open>
                <pre className="text-plain" style={{ maxHeight: 320, overflow: "auto" }}>{headers}</pre>
              </Fold>
            </div>
          ) : null}

          {/* C9: an invite the mailbox can read, and a contact card it can keep. */}
          {data.calendar ? (
            <div className="mt">
              <Fold title={t("msg.inviteTitle")} open={insights}>
                <div className="stack">
                  {data.calendar.summary ? <div><b>{data.calendar.summary}</b></div> : null}
                  {data.calendar.startsAt ? <div>🕒 {data.calendar.startsAt}</div> : null}
                  {data.calendar.endsAt ? <div>→ {data.calendar.endsAt}</div> : null}
                  {data.calendar.location ? <div>📍 {data.calendar.location}</div> : null}
                </div>
              </Fold>
            </div>
          ) : null}
          {data.vcard ? (
            <div className="mt">
              <Fold title={t("msg.vcardTitle")} open={insights}>
                <div className="stack">
                  {data.vcard.name ? <div><b>{data.vcard.name}</b></div> : null}
                  {data.vcard.org ? <div className="muted">{data.vcard.org}</div> : null}
                  {data.vcard.email ? <div className="addr">{data.vcard.email}</div> : null}
                  {data.vcard.email ? (
                    <button
                      className="small"
                      onClick={() => {
                        void api
                          .saveContact({ address: data.vcard!.email ?? "", name: data.vcard!.name })
                          .then(() => setNotice(t("msg.contactSaved")))
                          .catch(() => undefined);
                      }}
                    >
                      {t("msg.saveContact")}
                    </button>
                  ) : null}
                </div>
              </Fold>
            </div>
          ) : null}

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

          {sent &&
          (data.sendStatus === SendStatus.Failed ||
            data.sendStatus === SendStatus.Bounced ||
            data.sendStatus === SendStatus.Rejected ||
            data.sendStatus === SendStatus.Suppressed) ? (
            <div className="banner error mt">
              <div>
                <strong>{t("msg.resendNotice")}</strong>
                {t("msg.resendBody")}
              </div>
              <button className="small" style={{ marginTop: 8 }} onClick={() => setConfirmResend(true)}>
                {t("msg.resendAction")}
              </button>
            </div>
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
                    <button
                      type="button"
                      className="thread-link"
                      onClick={() => {
                        onOpenMessage(m.id);
                        if (threadExcerpts[m.id]) {
                          setThreadExcerpts((cur) => { const next = { ...cur }; delete next[m.id]; return next; });
                        } else {
                          void api.getMessage(m.id).then((full) => {
                            setThreadExcerpts((cur) => ({ ...cur, [m.id]: (full.textBody ?? "").slice(0, 400) }));
                          });
                        }
                      }}
                    >
                      {entry}
                    </button>
                  ) : (
                    <Link to={`/messages/${m.id}`} className="thread-link">
                      {entry}
                    </Link>
                  )}
                
                  {threadExcerpts[m.id] ? (
                    <pre className="thread-excerpt">{threadExcerpts[m.id]}</pre>
                  ) : null}</li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {forwarding ? (
        <Suspense fallback={null}>
          <Composer
            forwardOf={data}
            sendableAliases={outbox.aliases}
            remaining={outbox.capabilities?.remaining ?? 0}
            bindingMissing={outbox.capabilities?.bindingMissing}
            onScheduled={() => setNotice(t("msg.scheduled"))}
            onClose={() => setForwarding(false)}
            onSent={() => {
              setForwarding(false);
              reload();
              outbox.reload();
              setNotice(t("msg.forwardSent"));
            }}
          />
        </Suspense>
      ) : null}

      {replying ? (
        <Suspense fallback={null}>
          <Composer
            replyTo={data}
            initialCc={replyAllCcValue}
            sendableAliases={outbox.aliases}
            remaining={outbox.capabilities?.remaining ?? 0}
            bindingMissing={outbox.capabilities?.bindingMissing}
            onScheduled={() => setNotice(t("msg.scheduled"))}
            onClose={() => { setReplying(false); setReplyAllCcValue(""); }}
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

      {confirmResend && (
        <ConfirmDialog
          title={t("msg.resendTitle")}
          confirmLabel={t("msg.resendConfirm")}
          description={t("msg.resendBody")}
          onConfirm={resend}
          onClose={() => setConfirmResend(false)}
        />
      )}

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
