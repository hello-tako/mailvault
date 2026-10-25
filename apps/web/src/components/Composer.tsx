import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiClientError } from "../lib/api";
import { formatBytes, fullTime } from "../lib/format";
import {
  SEND_LIMITS,
  type MessageDetail,
  type RecipientSuggestion,
  type SendOutcome,
} from "@mailvault/shared";
import { t } from "../lib/i18n";
import { clearDraft, draftIsBlank, readDraft, saveDraft } from "../lib/drafts";
import type { SendableAlias } from "../lib/useOutbox";
import { Modal } from "./ui";

/** A reason to refuse the send button, phrased in the interface language. */
const ERROR_KEYS: Record<string, string> = {
  UNKNOWN_SENDER: "send.err.unknownSender",
  SENDING_DISABLED: "send.err.sendingDisabled",
  BINDING_MISSING: "send.err.binding",
  NO_RECIPIENTS: "send.err.noRecipients",
  NO_TARGET: "send.err.noTarget",
  NO_ALIAS: "send.err.noAlias",
  TOO_MANY_RECIPIENTS: "send.err.tooMany",
  DAILY_LIMIT: "send.err.dailyLimit",
  SPOOFED_PARENT: "send.err.spoofedParent",
  UNVERIFIED_PARENT: "send.err.unverifiedParent",
  EMPTY_BODY: "send.err.empty",
  TOO_LARGE: "send.err.tooLarge",
  BAD_ADDRESS: "send.err.badAddress",
  TOO_MANY_ATTACHMENTS: "send.err.tooManyAttachments",
  BAD_ATTACHMENT: "send.err.badAttachment",
  E_RECIPIENT_SUPPRESSED: "send.err.suppressed",
  E_DAILY_LIMIT_EXCEEDED: "send.err.dailyLimit",
  E_SENDER_NOT_VERIFIED: "send.err.sendingDisabled",
  E_TOO_MANY_RECIPIENTS: "send.err.tooMany",
  E_CONTENT_TOO_LARGE: "send.err.tooLarge",
};

function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A chosen file, read into memory and waiting for the send button. */
interface PendingFile {
  name: string;
  type: string;
  /** Bytes on disk, which is what the owner reads in the chip. */
  size: number;
  /** The same bytes as the request carries them. */
  content: string;
  /** An image may live inside the text rather than under it (B3): the cid name the body
   * references and the wire part will both carry. */
  inline?: boolean;
  cidToken?: string;
}

/** Base64 of a file, chunked so a large one cannot blow the argument list. */
async function readAsBase64(file: File): Promise<PendingFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: bytes.byteLength,
    content: btoa(binary),
  };
}

/**
 * What this compose will weigh once it is a message.
 *
 * Base64 writes four characters for every three bytes, so a file is always a third bigger on
 * the wire than on disk. This is deliberately the rough figure the compose screen can update on
 * every keystroke; the Worker measures the assembled bytes and has the last word.
 */
function wireSize(text: string, files: PendingFile[]): number {
  const payload = new TextEncoder().encode(text).byteLength + files.reduce((n, f) => n + f.size, 0);
  return Math.ceil((payload / 3) * 4);
}

/**
 * The original, folded into the reply the way any mail client does it.
 *
 * The quote is built from the body the owner is looking at, so it cannot be pointed at
 * somebody else's message, and it is capped: quoting a 400 kB log dump into a reply would
 * push the answer past the size a single message may be.
 */
function quoteOf(m: MessageDetail, max = 6000): string {
  const body = (m.textBody ?? "").trim();
  if (!body) return "";
  const clipped = body.length > max ? `${body.slice(0, max)}\n…` : body;
  const who = m.headerFrom ?? m.envelopeFrom;
  const when = fullTime(m.receivedAt);
  const quoted = clipped
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `\n\n── ${t("composer.quotedFrom", { who, when })} ──\n${quoted}`;
}

/**
 * One recipient line, completed from this mailbox's own correspondence.
 *
 * Only the fragment being typed is matched, and only the tail of the field is replaced on
 * pick, so completing "cus" never rewrites the addresses already committed before it. The
 * list is a real combobox because Enter here means "accept the suggestion", not "send" — a
 * mailbox must not fire off a message because somebody finished an address.
 */
function RecipientField({
  id,
  label,
  hint,
  value,
  onPick,
}: {
  /** Stable because it is what the label points at: derived from a translated string, two
   *  Vietnamese labels could collapse to the same id and unlatch both fields. */
  id: string;
  label: string;
  hint: string;
  value: string;
  onPick: (next: string) => void;
}) {
  const [items, setItems] = useState<RecipientSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Everything after the last separator is the token worth completing.
  const tailStart =
    Math.max(value.lastIndexOf(","), value.lastIndexOf(";"), value.lastIndexOf("\n")) + 1;
  const tail = value.slice(tailStart);
  const token = tail.trim();

  useEffect(() => {
    if (token.length < 2) {
      setItems([]);
      setOpen(false);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      api
        .recipients(token)
        .then((r) => {
          if (stale) return;
          setItems(r.items);
          setActive(0);
          setOpen(r.items.length > 0);
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [token]);

  function complete(suggestion: RecipientSuggestion) {
    onPick(`${value.slice(0, tailStart)}${suggestion.address}, `);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || items.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      e.preventDefault();
      complete(items[active] ?? items[0]!);
      return;
    }
    if (e.key === "Escape") {
      // Stops before the modal's own Escape handler, so the first Escape closes the list and
      // the second one leaves the composer.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="field recipient-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        onChange={(e) => {
          onPick(e.target.value);
          setOpen(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder={hint}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${id}-opt-${active}` : undefined}
      />
      {/* The input names this list through aria-controls; giving the list the same accessible
          name as the field would make the field itself ambiguous to locate. */}
      {open ? (
        <ul className="recip-list" id={`${id}-list`} role="listbox">
          {items.map((it, i) => (
            <li
              key={it.address}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "is-active" : ""}
              onMouseDown={(e) => {
                // mousedown, not click: the input's blur would otherwise close the list first.
                e.preventDefault();
                complete(it);
              }}
            >
              <span className="recip-name">{it.name ?? it.address}</span>
              {it.name && it.name !== it.address ? (
                <span className="recip-addr faint">{it.address}</span>
              ) : null}
              {it.outgoing ? (
                <span className="recip-tag faint">{t("composer.youWrote")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Compose a new message, or answer one.
 *
 * In reply mode neither end is editable: the sender is the alias the message arrived on and
 * the recipient is whoever that message named, both decided by the Worker. Showing an
 * editable "To" the server would ignore would be worse than showing no field at all, so the
 * resolved party is shown as text instead.
 */
export function Composer({
  replyTo,
  forwardOf,
  sendableAliases,
  remaining,
  bindingMissing = false,
  onClose,
  onSent,
  onScheduled,
  initialCc,
}: {
  replyTo?: MessageDetail | null;
  /** Forwarding one stored message: compose fields plus the original, quoted or attached. */
  forwardOf?: MessageDetail | null;
  sendableAliases: SendableAlias[];
  remaining: number;
  /** The server has no way to send at all — said once, up front, instead of on Submit. */
  bindingMissing?: boolean;
  onClose: () => void;
  onSent: (outcome: SendOutcome) => void;
  /** A scheduled send left the composer waiting, not gone (B6). */
  onScheduled?: (scheduled: { id: string; sendAt: string }) => void;
  /** Reply-all's copy line, prefilled (C8). */
  initialCc?: string;
}) {
  const isReply = !!replyTo;
  const isForward = !!forwardOf;
  // The slot this composer autosaves into (B4): one for a new message, one per message
  // being answered. Server-side, so the words follow the owner between devices.
  const sourceAttachments = useMemo(
    () => (replyTo?.attachments ?? forwardOf?.attachments ?? []),
    [replyTo, forwardOf],
  );

  const draftSlot = useMemo(
    () => (replyTo ? `reply-${replyTo.id}` : forwardOf ? null : "compose"),
    [replyTo, forwardOf],
  );
  // A new compose picks up where the last one left off, on this device only. A reply has
  // its context in the message it answers, so it never touches the draft slot.
  const [restoredDraft] = useState(() => (replyTo ? null : readDraft()));
  const [from, setFrom] = useState(replyTo?.aliasAddress ?? restoredDraft?.from ?? sendableAliases[0]?.address ?? "");
  const [to, setTo] = useState(restoredDraft?.to ?? "");
  const [cc, setCc] = useState(initialCc ?? restoredDraft?.cc ?? "");
  const [bcc, setBcc] = useState("");
  // A reply starts from the subject it answers (the Worker adds "Re:" if it is missing);
  // the owner can still reword it, and bring more people into the copy line.
  const [subject, setSubject] = useState(
    forwardOf?.subject
      ? /^fwd:/i.test(forwardOf.subject)
        ? forwardOf.subject
        : `Fwd: ${forwardOf.subject}`
      : (replyTo?.subject ?? restoredDraft?.subject ?? ""),
  );
  const [fromName, setFromName] = useState("");
  const [attachOriginal, setAttachOriginal] = useState(true);
  // B6: send now, or let it wait (a wait is also the undo window). B2: files already in
  // the vault, from the message being answered or forwarded, ride along as references.
  const [delaySec, setDelaySec] = useState(0);
  const [refIds, setRefIds] = useState<Set<string>>(new Set());
  const [text, setText] = useState(() => (replyTo ? quoteOf(replyTo) : restoredDraft?.text ?? ""));
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A draft saved on another device fills this composer on open — before typing starts,
  // so it can never overwrite a word the owner has already changed here.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || !draftSlot) return;
    hydratedRef.current = true;
    void api.getDraft(draftSlot).then(({ draft }) => {
      if (!draft) return;
      setFrom(draft.fromAddress ?? from);
      setTo(draft.to ?? to);
      setCc(draft.cc ?? "");
      setBcc(draft.bcc ?? "");
      setSubject(draft.subject ?? subject);
      if (!isReply) setText(draft.text ?? text);
      else if ((draft.text ?? "").trim()) setText(draft.text ?? text);
    }).catch(() => undefined);
    // Runs once: a hydrate that raced typing would overwrite the owner's words.
  }, []);

  // Debounced autosave, twice over (B4): this browser's storage for an instant restore, the
  // vault's row for every other device. A blank slot saves as a delete, not as an empty
  // promise.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!draftSlot) return;
      const blank = !from && !to && !cc && !bcc && !subject.trim() && !text.trim();
      if (blank) {
        void api.deleteDraft(draftSlot).catch(() => undefined);
        if (!isReply) clearDraft();
        return;
      }
      void api
        .saveDraft(draftSlot, {
          fromAddress: from || null,
          to: to || null,
          cc: cc || null,
          bcc: bcc || null,
          subject: subject || null,
          text: text || null,
          replyToMessageId: isReply ? replyTo!.id : null,
        })
        .catch(() => undefined);
      if (!isReply && !draftIsBlank({ from, to, cc, subject, text })) {
        saveDraft({ from, to, cc, subject, text });
      } else if (!isReply) {
        clearDraft();
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [draftSlot, isReply, from, to, cc, bcc, subject, text]);
  const body = useRef<HTMLTextAreaElement>(null);
  const sendKey = useRef(crypto.randomUUID());

  useEffect(() => {
    body.current?.focus();
  }, []);

  const otherParty = useMemo(() => {
    if (!replyTo) return "";
    if (replyTo.direction === "OUT") return replyTo.headerTo ?? "";
    return replyTo.replyTo ?? replyTo.headerFrom ?? replyTo.envelopeFrom;
  }, [replyTo]);

  const recipientCount = splitAddresses(to).length + splitAddresses(cc).length;
  // The address the message really leaves under. It is the alias itself unless the domain was
  // pointed at one of its zone's sending subdomains, and the owner is told either way.
  const leavesAs = (address: string) =>
    sendableAliases.find((a) => a.address === address)?.sendingAddress ?? address;
  const leaving = leavesAs(isReply ? replyTo.aliasAddress : from);
  const throughSubdomain = leaving !== (isReply ? replyTo.aliasAddress : from);
  const total = wireSize(text, files);
  const overBudget = total > SEND_LIMITS.maxTotalBytes;
  const canSend =
    !bindingMissing &&
    !overBudget &&
    // A forward's body is the message it carries; an intro is optional when the original
    // rides along, required when it does not (the checkbox covers that choice).
    (isReply
      ? text.trim().length > 0
      : isForward
        ? splitAddresses(to).length > 0 && (attachOriginal || text.trim().length > 0)
        : splitAddresses(to).length > 0 && text.trim().length > 0);

  /**
   * Read what was chosen, and say so when one of them cannot go.
   *
   * A file too big to fit is reported and skipped rather than failing the whole pick: dropping
   * four good invoices because the fifth was a video nobody meant to attach would throw away
   * work the owner just did.
   */
  /** Markdown for one inline image, placed where the cursor is — the owner sees the
   * picture's place in the text as they write it, not after it leaves. */
  function insertAtCursor(snippet: string) {
    const el = body.current;
    if (!el) {
      setText((current) => current + snippet);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    setText(text.slice(0, start) + snippet + text.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  }

  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = [...(e.target.files ?? [])];
    // Cleared first, or choosing the same file again after removing it would be no change.
    e.target.value = "";
    const room = SEND_LIMITS.maxAttachments - files.length;
    if (picked.length > room)
      setError(t("composer.tooManyFiles", { n: SEND_LIMITS.maxAttachments }));
    const accepted: PendingFile[] = [];
    for (const f of picked.slice(0, Math.max(room, 0))) {
      // A file larger than a whole message can never be sent, and reading it into base64 to
      // find that out would freeze the tab. Everything else is kept and counted against the
      // budget below, which is where a message made of several near-limit files is caught.
      if (f.size > SEND_LIMITS.maxTotalBytes) {
        setError(
          t("composer.fileTooLarge", { name: f.name, max: formatBytes(SEND_LIMITS.maxTotalBytes) }),
        );
        continue;
      }
      const base = await readAsBase64(f);
      if (f.type.startsWith("image/")) {
        accepted.push({
          ...base,
          inline: true,
          cidToken: `cidfile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        });
      } else {
        accepted.push(base);
      }
    }
    if (accepted.length > 0) {
      setFiles((current) => [...current, ...accepted]);
      const images = accepted.filter((f) => f.inline && f.cidToken);
      if (images.length) {
        insertAtCursor(images.map((f) => `![](cid:${f.cidToken})`).join("\n"));
      }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSend || busy) return;
    setBusy(true);
    setError(null);
    const attachments = files.map((f) => ({
      filename: f.name,
      type: f.type,
      content: f.content,
      ...(f.inline && f.cidToken ? { inline: true, cidToken: f.cidToken } : {}),
    }));
    try {
      const ccList = splitAddresses(cc);
      const bccList = splitAddresses(bcc);
      const attachmentRefs = (
        (replyTo?.attachments ?? forwardOf?.attachments ?? [])
          .filter((a) => refIds.has(a.id))
          .map((a) => ({ messageId: (replyTo ?? forwardOf)!.id, attachmentId: a.id }))
      ) as Array<{ messageId: string; attachmentId: string }>;
      if (delaySec > 0) {
        const payload = isReply && replyTo
          ? {
              text,
              ...(ccList.length > 0 ? { cc: ccList } : {}),
              ...(subject.trim() ? { subject: subject.trim() } : {}),
              ...(fromName.trim() ? { fromName: fromName.trim() } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
              replyToMessageId: replyTo.id,
            }
          : {
              fromAddress: from,
              to: splitAddresses(to),
              ...(ccList.length > 0 ? { cc: ccList } : {}),
              ...(bccList.length > 0 ? { bcc: bccList } : {}),
              subject,
              text,
              ...(fromName.trim() ? { fromName: fromName.trim() } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
            };
        const scheduled = await api.scheduleSend(
          isReply ? "reply" : "compose",
          payload as Record<string, unknown>,
          delaySec,
        );
        if (draftSlot) void api.deleteDraft(draftSlot).catch(() => undefined);
        if (!isReply) clearDraft();
        onScheduled?.(scheduled);
        setBusy(false);
        return;
      }
      if (isForward && forwardOf) {
        const outcome = await api.forwardMessage(
          forwardOf.id,
          {
            fromAddress: from,
            to: splitAddresses(to),
            ...(ccList.length > 0 ? { cc: ccList } : {}),
            ...(bccList.length > 0 ? { bcc: bccList } : {}),
            ...(subject.trim() ? { subject: subject.trim() } : {}),
            intro: text,
            attachOriginal,
          },
          sendKey.current,
        );
        if (draftSlot) void api.deleteDraft(draftSlot).catch(() => undefined);
        onSent(outcome);
        setBusy(false);
        return;
      }
      const outcome = isReply
        ? await api.reply(
            replyTo.id,
            {
              text,
              ...(ccList.length > 0 ? { cc: ccList } : {}),
              ...(subject.trim() ? { subject: subject.trim() } : {}),
              ...(fromName.trim() ? { fromName: fromName.trim() } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
            },
            sendKey.current,
          )
        : await api.compose(
            {
              fromAddress: from,
              to: splitAddresses(to),
              ...(ccList.length > 0 ? { cc: ccList } : {}),
              ...(bccList.length > 0 ? { bcc: bccList } : {}),
              subject,
              text,
              ...(fromName.trim() ? { fromName: fromName.trim() } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
            },
            sendKey.current,
          );
      if (!isReply) clearDraft();
      if (draftSlot) void api.deleteDraft(draftSlot).catch(() => undefined);
      onSent(outcome);
    } catch (err) {
      const code = (err as ApiClientError).code ?? "";
      const key = ERROR_KEYS[code];
      setError(key ? t(key) : (err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={t(isForward ? "composer.forwardTitle" : isReply ? "composer.replyTitle" : "composer.title")} onClose={onClose}>
      <form onSubmit={submit} className="composer">
        {isReply ? (
          <>
            <div className="field">
              <label>{t("composer.answerTo")}</label>
              <div className="composer-static mono">{otherParty}</div>
              <div className="field-hint">
                {throughSubdomain
                  ? t("composer.leavesVia", { sending: leaving, alias: replyTo.aliasAddress })
                  : t("composer.fromRow", { alias: replyTo.aliasAddress })}
              </div>
            </div>
            <details className="composer-cc">
              <summary>{t("composer.cc")}</summary>
              <RecipientField
                id="reply-cc"
                label={t("composer.cc")}
                hint="someone-else@example.com"
                value={cc}
                onPick={setCc}
              />
            </details>
            <div className="field">
              <label htmlFor="reply-subject">{t("composer.subject")}</label>
              <input
                id="reply-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={998}
              />
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="compose-from">{t("composer.from")}</label>
              {sendableAliases.length === 0 ? (
                <div className="composer-static">{t("composer.noAliases")}</div>
              ) : (
                <>
                  <select id="compose-from" value={from} onChange={(e) => setFrom(e.target.value)}>
                    {sendableAliases.map((a) => (
                      <option key={a.address} value={a.address}>
                        {a.label ? `${a.label} — ${a.address}` : a.address}
                      </option>
                    ))}
                  </select>
                  {throughSubdomain ? (
                    <div className="field-hint">
                      {t("composer.leavesVia", { sending: leaving, alias: from })}
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <RecipientField
              id="compose-to"
              label={t("composer.to")}
              hint="someone@example.com"
              value={to}
              onPick={setTo}
            />
            {recipientCount > 0 ? (
              <div className="field-hint">{t("composer.recipients", { n: recipientCount })}</div>
            ) : null}
            <details className="composer-cc">
              <summary>{t("composer.ccBcc")}</summary>
              <RecipientField
                id="compose-cc"
                label={t("composer.cc")}
                hint="someone-else@example.com"
                value={cc}
                onPick={setCc}
              />
              <RecipientField
                id="compose-bcc"
                label={t("composer.bcc")}
                hint="quiet-copy@example.com"
                value={bcc}
                onPick={setBcc}
              />
            </details>
            {isForward ? (
              <div className="field">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={attachOriginal}
                    onChange={(e) => setAttachOriginal(e.target.checked)}
                  />
                  {t("composer.attachOriginal")}
                </label>
                <div className="field-hint">{t("composer.attachOriginalHint")}</div>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="compose-subject">{t("composer.subject")}</label>
              <input
                id="compose-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={998}
              />
            </div>
            <div className="field">
              <label htmlFor="compose-fromname">{t("composer.fromName")}</label>
              <input
                id="compose-fromname"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                maxLength={120}
                placeholder={t("composer.fromNameHint")}
              />
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="compose-body">{t("composer.body")}</label>
          <textarea
            id="compose-body"
            ref={body}
            rows={isReply ? 6 : 10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("composer.bodyHint")}
          />
        </div>

        <div className="field composer-files">
          {/* Left as the native control it is: the browser's own file picker is what brings
              "take a photo" and "browse files" on a phone, and restyling it as a button of ours
              would put an invisible input behind a visible label. */}
          <label htmlFor="compose-files">{t("composer.attach")}</label>
          <input id="compose-files" type="file" multiple onChange={onPickFiles} />
          <div className="field-hint">
            {files.length > 0
              ? t("composer.attachBudget", {
                  size: formatBytes(total),
                  max: formatBytes(SEND_LIMITS.maxTotalBytes),
                })
              : t("composer.attachHint", {
                  n: SEND_LIMITS.maxAttachments,
                  max: formatBytes(SEND_LIMITS.maxTotalBytes),
                })}
          </div>
          {files.length > 0 ? (
            <ul className="file-list">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  <span className="file-name">{f.name}</span>
                  <span className="faint">{formatBytes(f.size)}</span>
                  {f.cidToken ? (
                    <label className="check small">
                      <input
                        type="checkbox"
                        checked={!!f.inline}
                        onChange={(e) => {
                          const inline = e.target.checked;
                          setFiles((current) =>
                            current.map((file, j) => (j === i ? { ...file, inline } : file)),
                          );
                          if (!inline && f.cidToken) {
                            setText((current) => current.replace(`![](cid:${f.cidToken})`, ""));
                          } else if (inline && f.cidToken && !text.includes(`cid:${f.cidToken}`)) {
                            insertAtCursor(`![](cid:${f.cidToken})`);
                          }
                        }}
                      />
                      {t("composer.inlineImage")}
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="ghost small"
                    aria-label={t("composer.removeFile", { name: f.name })}
                    onClick={() => {
                      setFiles((current) => current.filter((_, j) => j !== i));
                      if (f.cidToken) setText((current) => current.replace(`![](cid:${f.cidToken})`, ""));
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {overBudget ? (
            <div className="field-hint is-error">{t("composer.overBudget")}</div>
          ) : null}
        </div>

        {sourceAttachments.length > 0 ? (
          <div className="field">
            <label>{t("composer.fromThisMessage")}</label>
            <ul className="file-list">
              {sourceAttachments.map((a) => (
                <li key={a.id}>
                  <label className="check small">
                    <input
                      type="checkbox"
                      checked={refIds.has(a.id)}
                      onChange={(e) => {
                        setRefIds((current) => {
                          const next = new Set(current);
                          if (e.target.checked) next.add(a.id);
                          else next.delete(a.id);
                          return next;
                        });
                      }}
                    />
                    <span className="file-name">{a.filename}</span>
                  </label>
                  <span className="faint">{formatBytes(a.size)}</span>
                </li>
              ))}
            </ul>
            <div className="field-hint">{t("composer.fromThisMessageHint")}</div>
          </div>
        ) : null}

        {bindingMissing && (
          <p className="banner error" role="alert">
            {t("composer.unavailable")}
          </p>
        )}
        {error && (
          <p className="banner banner--error" role="alert">
            {error}
          </p>
        )}

        <div className="row spread composer-foot">
          <span className="faint" style={{ fontSize: 13 }}>
            {t("composer.remaining", { n: remaining })}
          </span>
          <div className="row-end">
            <button type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={!canSend || sendableAliases.length === 0}
              aria-busy={busy}
            >
              {t(busy ? "composer.sending" : "composer.send")}
            </button>
            <select
              aria-label={t("composer.sendDelay")}
              value={delaySec}
              onChange={(e) => setDelaySec(Number(e.target.value))}
            >
              <option value={0}>{t("composer.delayNow")}</option>
              <option value={10}>{t("composer.delay10")}</option>
              <option value={60}>{t("composer.delay1m")}</option>
              <option value={600}>{t("composer.delay10m")}</option>
              <option value={3600}>{t("composer.delay1h")}</option>
            </select>
          </div>
        </div>
      </form>
    </Modal>
  );
}
