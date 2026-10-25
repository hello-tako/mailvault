/**
 * Email HTML is hostile input (section 19). We never inject it into the app DOM; the
 * only place it is rendered is a `sandbox=""` iframe (see web/MessageView). This
 * server-side sanitizer is defense-in-depth: an allowlist-based tag/attribute filter
 * that removes scripts, event handlers, forms, remote resource loading, and
 * javascript:/data: URLs before content ever reaches the browser.
 *
 * Deliberately conservative: `style` attributes are dropped entirely (blocks
 * CSS url()/expression and fingerprinting); layout is degraded but that is an
 * acceptable trade for a private utility.
 */

const ALLOWED_TAGS = new Set([
  "a", "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "small", "sub", "sup",
  "ul", "ol", "li", "blockquote", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "hr", "img", "figure", "figcaption",
]);

// Tags whose entire subtree (including text) is discarded. The opening tag is consumed up
// to its own ">" first: an earlier pattern allowed ">" alone to close the match, which left
// a script's source visible as text after the tag was removed.
const NEVER_RENDER = "script|style|iframe|object|embed|form|input|button|textarea|select|option|svg|math|link|meta|base|noscript|template|applet|marquee|frame|frameset";
const DROP_WITH_CONTENT = new RegExp(`<\\s*(${NEVER_RENDER})\\b[^>]*>[\\s\\S]*?<\\/\\s*\\1\\s*>`, "gi");
// Raw-text elements swallow the rest of the document when never closed, which is also what
// a browser would do — so dropping it here cannot hide real content.
const DROP_UNCLOSED_RAW = new RegExp(`<\\s*(?:script|style)\\b[^>]*>[\\s\\S]*$`, "gi");

const SAFE_HREF = /^(?:https?:|mailto:|tel:)/i;

const GLOBAL_ATTRS = new Set(["alt", "title", "colspan", "rowspan", "align", "width", "height"]);

interface AttrPair {
  name: string;
  value: string | null;
}

function parseAttributes(raw: string): AttrPair[] {
  const out: AttrPair[] = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of raw.matchAll(re)) {
    const name = (m[1] ?? "").toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? (m[1] ? null : null);
    out.push({ name, value: value === null ? null : value });
  }
  return out;
}

function sanitizeHref(value: string): string | null {
  // eslint-disable-next-line no-control-regex
  const v = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!SAFE_HREF.test(v)) return null; // blocks javascript:, data:, vbscript:, relative-only junk
  return v;
}

function sanitizeImgSrc(value: string, allowRemote: boolean, keepCid = false): string | null {
  // A cid: reference points at the message's own attachment, not at the network — no
  // tracking pixel can ride one, so the reader's detail route may keep them to resolve
  // server-side into data URLs (plan C2/B3).
  if (keepCid && /^cid:/i.test(value.trim())) return value.trim();
  if (!allowRemote) return null; // block remote/tracking images by default
  const v = value.trim();
  return /^https:\/\//i.test(v) ? v : null; // https only, never http
}

function filterAttributes(tag: string, raw: string, allowRemoteImages: boolean, keepCidImages: boolean): string {
  const attrs = parseAttributes(raw);
  const kept: string[] = [];
  const isAnchor = tag === "a";
  for (const { name, value } of attrs) {
    if (name.startsWith("on")) continue; // event handlers
    if (name === "style") continue; // dropped entirely
    if (name === "srcdoc" || name === "formaction" || name === "xlink:href" || name === "dynsrc" || name === "lowsrc") continue;

    if (name === "href" && isAnchor) {
      const href = value ? sanitizeHref(value) : null;
      if (href) kept.push(`href="${escapeAttr(href)}"`);
      continue;
    }
    if (name === "src" && tag === "img") {
      const src = value ? sanitizeImgSrc(value, allowRemoteImages, keepCidImages) : null;
      if (src) kept.push(`src="${escapeAttr(src)}"`);
      continue;
    }
    if (name === "target") continue; // we re-add for anchors
    if (name === "rel") continue;

    if (GLOBAL_ATTRS.has(name) && value != null) {
      kept.push(`${name}="${escapeAttr(value)}"`);
    }
  }
  if (isAnchor) {
    // Force safe external navigation (section 18).
    kept.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
  }
  return kept.length ? " " + kept.join(" ") : "";
}

function escapeAttr(v: string): string {
  return v.replace(BARE_AMP, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface SanitizeOptions {
  allowRemoteImages?: boolean;
  /** Keep `src="cid:…"` references (the message's own attachments) instead of dropping them. */
  keepCidImages?: boolean;
  maxChars?: number;
}

export function sanitizeEmailHtml(input: string, opts: SanitizeOptions = {}): string {
  const allowRemote = opts.allowRemoteImages ?? false;
  const keepCid = opts.keepCidImages ?? false;
  const maxChars = opts.maxChars ?? 500_000;
  if (!input) return "";

  let html = input.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(DROP_WITH_CONTENT, "").replace(DROP_UNCLOSED_RAW, "");

  let out = "";
  let last = 0;
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  for (const m of html.matchAll(tagRe)) {
    const full = m[0];
    const tag = (m[1] ?? "").toLowerCase();
    const attrRaw = m[2] ?? "";
    const isClosing = full.startsWith("</");
    const index = m.index ?? 0;

    out += escapeText(html.slice(last, index));
    last = index + full.length;

    if (!ALLOWED_TAGS.has(tag)) continue; // drop unknown tags, keep their inner text
    if (isClosing) {
      out += `</${tag}>`;
    } else {
      const selfClose = full.trimEnd().endsWith("/>");
      const allowed = filterAttributes(tag, attrRaw, allowRemote, keepCid);
      out += `<${tag}${allowed}${selfClose ? " /" : ""}>`;
    }
  }
  out += escapeText(html.slice(last));

  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

// Escape raw text between tags so stray < > never start markup in the iframe.
// A bare `&` must become `&amp;`, but an existing character reference must survive —
// escaping it twice is what made real GitHub mail print "&#160;" everywhere.
// Entities only ever decode to characters, and the iframe is `sandbox=""`, so keeping
// them cannot introduce script execution.
const BARE_AMP = /&(?!#x[0-9a-f]{1,8};|#[0-9]{1,8};|[a-zA-Z][a-zA-Z0-9]{1,31};)/gi;

function escapeText(text: string): string {
  return text.replace(BARE_AMP, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
