/**
 * Whether an HTML body has anything a reader would call content.
 *
 * Real mail arrives with a body that is whitespace, a stray `&nbsp;`, or an empty wrapper
 * table around nothing at all. Rendering that as a sandboxed frame gives a tall white box and
 * no explanation, so the screen asks this first and falls back to the text part — or to
 * saying plainly that there is nothing to read.
 */
export function htmlHasContent(html: string): boolean {
  if (!html.trim()) return false;
  // An image-only newsletter has no words and is far from empty.
  if (/<img\b[^>]*\bsrc\s*=\s*["'][^"']+["']/i.test(html)) return true;
  const words = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|thinsp|ensp|emsp|#0*(160|8201|8194|8195|8196));/gi, " ")
    .trim();
  return words.length > 0;
}
