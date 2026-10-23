import { CopyButton } from "../ui";
import { t } from "../../lib/i18n";
import {
  AuthVerdict,
  type ExtractedCode,
  type MessageAuth,
  type VerificationLink,
} from "@mailvault/shared";

/**
 * The two things this mailbox exists to surface — a code and a magic link — and the verdict
 * about who actually sent the message.
 *
 * All three read from what ingest already extracted, so a screen never re-parses a body to
 * find out what it said.
 */

function byConfidence(a: ExtractedCode, b: ExtractedCode): number {
  return b.confidence - a.confidence || b.length - a.length;
}

function byScore(a: VerificationLink, b: VerificationLink): number {
  return b.score - a.score;
}

export function sortCodes(codes: ExtractedCode[]): ExtractedCode[] {
  return codes.slice().sort(byConfidence);
}

export function sortLinks(links: VerificationLink[]): VerificationLink[] {
  return links.slice().sort(byScore);
}

export function CodeCard({ code }: { code: ExtractedCode }) {
  return (
    <div className="code-card">
      <div>
        <div className="code">{code.value}</div>
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
          {t(code.kind === "numeric" ? "msg.numericCode" : "msg.code")} ·{" "}
          {t("msg.codeLength", { n: code.length })}
        </div>
      </div>
      <CopyButton text={code.value} label={t("msg.copyCode")} />
    </div>
  );
}

function displayHost(link: VerificationLink): string {
  try {
    return new URL(link.destination ?? link.url).hostname;
  } catch {
    return link.hostname;
  }
}

export function LinkCard({ link }: { link: VerificationLink }) {
  const target = link.destination ?? link.url;
  const wrapped = !!link.destination && link.destination !== link.url;
  return (
    <div className="link-card">
      <div className="link-card-head">
        <span className="link-title">{link.label || t("msg.verificationLink")}</span>
        <span className="link-host">{displayHost(link)}</span>
      </div>
      {wrapped && (
        <div className="link-via">
          {t("msg.trackingA")}
          <span className="addr">{link.hostname}</span>
          {t("msg.trackingB")}
        </div>
      )}
      {/* The whole address, readable and selectable: a 400-char magic link behind an "Open"
          button tells the owner nothing about where their token is going. */}
      <div className="link-url">{target}</div>
      <div className="row wrap" style={{ gap: 8 }}>
        <CopyButton text={target} label={t("msg.copyLink")} />
        {/* Explicit user action only: never auto-followed, never prefetched. */}
        <a
          className="small"
          href={target}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-label={t("msg.openAria", { host: displayHost(link) })}
        >
          {t("msg.open")}
        </a>
        {wrapped && (
          <a
            className="small ghost"
            href={link.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            {t("msg.openAsSent")}
          </a>
        )}
      </div>
    </div>
  );
}

function outcomeLabel(auth: MessageAuth | null): string {
  if (!auth) return t("msg.authNotAssessed");
  const mark = (mech: "spf" | "dkim" | "dmarc", value: string | null) =>
    value ? `${mech}=${value}${auth.alignedPass[mech] ? "*" : ""}` : null;
  const parts = [mark("spf", auth.spf), mark("dkim", auth.dkim), mark("dmarc", auth.dmarc)].filter(
    Boolean,
  );
  if (parts.length === 0) return t("msg.authNone");
  const aligned = auth.alignedPass.spf || auth.alignedPass.dkim || auth.alignedPass.dmarc;
  return aligned
    ? `${parts.join("  ")}  ${t("msg.authVouches")}`
    : `${parts.join("  ")}  ${t("msg.authNoVouch")}`;
}

/**
 * The one-line verdict. What it was measured against is `AuthDetail`, which sits folded under
 * the message: the conclusion belongs where a reader can see it without asking, the evidence
 * belongs where they can ask. The one exception main hardened and its test demands: an
 * UNVERIFIED verdict explains *why* it cannot vouch — header results alone establish nothing.
 */
export function AuthBanner({ verdict, auth }: { verdict: AuthVerdict; auth?: MessageAuth | null }) {
  const head =
    verdict === AuthVerdict.Trusted
      ? "msg.authTrusted"
      : verdict === AuthVerdict.Spoofed
        ? "msg.authSpoofed"
        : "msg.authUnverified";
  const cls =
    verdict === AuthVerdict.Trusted
      ? "trusted"
      : verdict === AuthVerdict.Spoofed
        ? "spoofed"
        : "unverified";
  return (
    <div className={`ribbon ${cls}`} role="status">
      <span className="dot" aria-hidden="true" />
      <span className="head">{t(head)}</span>
      {verdict === AuthVerdict.Unverified ? (
        <>
          {!auth ? <span className="ribbon-note">{t("msg.authAssessmentUnavailable")}</span> : null}
          <span className="ribbon-note">{t("msg.authSourceUntrusted")}</span>
        </>
      ) : null}
      {verdict === AuthVerdict.Spoofed && auth?.reasons.length ? (
        <span className="ribbon-note">{t("msg.authWhy", { reasons: auth.reasons.join("; ") })}</span>
      ) : null}
    </div>
  );
}

/** What the verdict was computed from, in the same words as its colour. */
export function AuthDetail({ verdict, auth }: { verdict: AuthVerdict; auth: MessageAuth | null }) {
  return (
    <div className="stack">
      <p className="mono-note">{outcomeLabel(auth)}</p>
      {verdict === AuthVerdict.Spoofed && auth?.reasons.length ? (
        <p className="muted" style={{ margin: 0 }}>
          {t("msg.authWhy", { reasons: auth.reasons.join("; ") })}
        </p>
      ) : null}
    </div>
  );
}
