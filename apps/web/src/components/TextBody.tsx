import { useMemo } from "react";
import { t } from "../lib/i18n";

/**
 * Plain-text mail is not one thing. A security notice is paragraphs; an OTP sits on its own
 * line; a signature, a quoted reply or an ASCII table is layout that must NOT reflow; and a
 * magic link has to be tappable on a phone without being cut. So split the body into blocks,
 * keep the preformatted ones in a monospace box, and linkify only http(s) — never rendering
 * email text as markup.
 */

const BLOCKS = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/;
/** Trailing sentence punctuation stays outside the link; the last URL char is never a comma. */
const URL_IN_TEXT = /(https?:\/\/[^\s<>"']*[^\s<>"'(),.;:!?])([),.;:!?]*)/g;

/** Indented lines survive in text/plain the way the sender aligned them; reflowing breaks them. */
function isPreformatted(block: string): boolean {
  const lines = block.split(/\r?\n/);
  return lines.length > 1 && lines.some((l) => /^[ \t]+\S/.test(l));
}

/*
 * Mailers hard-wrap plain text at ~70 columns. On a 412px screen that leaves half-empty
 * lines, so a paragraph is re-flowed — but only where the break is clearly incidental:
 * a short line, a line ending a sentence, or one starting a list/quote is left alone.
 * A side effect we want: a URL the mailer split across such a break becomes one string
 * again, and the linkifier below then offers the complete address.
 */
const MIN_FLOW_LINE = 40;
const SENTENCE_END = /[.!?:;]$/;
const STARTS_NEW_ITEM = /^\s*([-*•>‣▪]|\d+[).]|[A-Z][a-z]{0,12}:$)/;
/** The mailer cut a line in the middle of an address: glue it back with no space. */
const ENDS_IN_URL = /https?:\/\/\S*$/;
const CUT_MID_URL = /[?&=%#/,+]$/;
const URL_CHARS_ONLY = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+;=%,-]+$/;
const QUERY_SYNTAX = /[?&=%#]/;

function reflow(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1] ?? "";
    const keepApart =
      out.length === 0 ||
      prev.trim().length < MIN_FLOW_LINE ||
      SENTENCE_END.test(prev.trimEnd()) ||
      STARTS_NEW_ITEM.test(line) ||
      line.trim() === "";
    if (keepApart) {
      out.push(line);
      continue;
    }
    const glued =
      CUT_MID_URL.test(prev) || (ENDS_IN_URL.test(prev) && URL_CHARS_ONLY.test(line.trim()) && QUERY_SYNTAX.test(line));
    out[out.length - 1] = glued ? prev + line : `${prev} ${line}`;
  }
  return out;
}

function Linkified({ line }: { line: string }) {
  const parts = useMemo(() => {
    const out: Array<{ text: string; href?: string }> = [];
    let last = 0;
    for (const m of line.matchAll(URL_IN_TEXT)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ text: line.slice(last, at) });
      let url = m[1] ?? "";
      let tail = m[2] ?? "";
      // `…/compare(a,b)` keeps its closing bracket; `…/verify.` does not keep the period.
      if (tail.startsWith(")") && (url.match(/\(/g)?.length ?? 0) > (url.match(/\)/g)?.length ?? 0)) {
        url += ")";
        tail = tail.slice(1);
      }
      out.push({ text: url, href: url });
      if (tail) out.push({ text: tail });
      last = at + url.length + tail.length;
    }
    if (last < line.length) out.push({ text: line.slice(last) });
    return out;
  }, [line]);

  return (
    <>
      {parts.map((p, i) =>
        p.href ? (
          // Explicit click only, like the link cards: never prefetched, never auto-followed.
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** A block is a quoted reply when most of its lines carry the ">" marker or it opens with
 * the "On … wrote:" convention: history the owner has usually already read once. */
function isQuotedReply(block: string): boolean {
  const lines = block.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;
  const marked = lines.filter((l) => /^\s*>/.test(l)).length;
  return marked / lines.length >= 0.6 || /^On .+wrote:\s*$/i.test(lines[0] ?? "");
}

export function TextBody({ text }: { text: string }) {
  const blocks = useMemo(() => text.split(BLOCKS).filter((b) => b.trim().length > 0), [text]);

  return (
    <div className="text-body">
      {blocks.map((block, i) => {
        if (isQuotedReply(block)) {
          // Folded, not hidden: one tap brings the history back exactly as it arrived.
          return (
            <details key={i} className="quote-fold">
              <summary>{t("msg.quotedReply", { n: block.split(/\r?\n/).length })}</summary>
              <pre className="text-plain">{block}</pre>
            </details>
          );
        }
        if (isPreformatted(block)) {
          return (
            <pre key={i} className="text-plain">
              {block}
            </pre>
          );
        }
        const lines = reflow(block.split(/\r?\n/));
        return (
          <p key={i} className="text-para">
            {lines.map((line, j) => (
              <span key={j} className="text-line">
                <Linkified line={line} />
                {j < lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
