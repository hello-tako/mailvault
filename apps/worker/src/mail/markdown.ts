/**
 * The tiny markdown a compose box needs (B2): paragraphs, line breaks, quotes, lists,
 * inline code, emphasis, strong, and https links. Nothing else — no headings, no tables,
 * no images, no raw HTML. The output goes straight through the same sanitizer every other
 * outbound HTML body passes, so even a bug here cannot smuggle a tag the reader would
 * render.
 *
 * Deliberately line-based: mail is written line by line, and a paragraph that keeps the
 * writer's line breaks reads closer to what they typed than one reflowed by a paragraph
 * re-flow algorithm that guesses.
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Emphasis and links inside one line. Escaped first, so a tag typed as text stays text. */
function inlineMarkdown(raw: string): string {
  return escapeHtml(raw)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export function markdownToHtml(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inlineMarkdown).join("<br>")}</p>`);
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote><p>${quote.map(inlineMarkdown).join("<br>")}</p></blockquote>`);
    quote = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (const raw of lines) {
    if (/^\s*$/.test(raw)) {
      flushPara();
      flushQuote();
      flushList();
      continue;
    }
    const quoted = raw.match(/^>\s?(.*)$/);
    if (quoted) {
      flushPara();
      flushList();
      quote.push(quoted[1] ?? "");
      continue;
    }
    const item = raw.match(/^[-*]\s+(.*)$/);
    if (item) {
      flushPara();
      flushQuote();
      list.push(item[1] ?? "");
      continue;
    }
    flushQuote();
    flushList();
    para.push(raw);
  }
  flushPara();
  flushQuote();
  flushList();
  return out.join("\n");
}
