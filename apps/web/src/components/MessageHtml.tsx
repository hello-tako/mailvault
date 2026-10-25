import { useEffect, useMemo, useState } from "react";
import { t } from "../lib/i18n";
import { useTheme } from "../lib/theme";

/**
 * Renders sanitized email HTML inside a `sandbox=""` iframe loaded from a Blob URL.
 * The parent document never contains email markup (section 19); an iframe CSP meta
 * plus the empty sandbox attribute are defense-in-depth on top of the server-side
 * sanitizer. Blob URLs are used (not srcdoc) so the Worker's `frame-src 'self' blob:`
 * policy allows the frame.
 *
 * The injected `<meta viewport>` is not decoration: a frame document without one is laid
 * out at ~980px on a handset, which pushes an ordinary email off the right edge.
 */
export function MessageHtml({ html }: { html: string }) {
  const [url, setUrl] = useState<string | null>(null);
  // Mail is written on white; the graphite theme would glare around it. The frame follows
  // the app theme by inverting the page and re-inverting the pictures, so photographs stay
  // photographs and only the paper turns (C3). Nothing is fetched and no script runs for
  // this — it is one style rule inside the same sandboxed document as before.
  const { choice } = useTheme();
  const dark =
    choice === "graphite" ||
    (choice === "system" &&
      typeof window !== "undefined" &&
      !window.matchMedia("(prefers-color-scheme: light)").matches);

  const doc = useMemo(() => {
    const csp = [
      "default-src 'none'",
      "img-src data: blob: https:",
      "style-src 'unsafe-inline'",
      "font-src data:",
      "sandbox allow-popups",
    ].join("; ");
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
html{color-scheme:light}
body{font:14px/1.55 system-ui,sans-serif;color:#111;background:#fff;margin:14px;overflow-wrap:break-word}
img,table,pre,video{max-width:100%}
img{height:auto}
table{border-collapse:collapse}
/* Legacy mail layout is a table of cells with width="300" attributes. A table's used width
   is at least its preferred width, so those hints make a 700px mail overflow a 360px frame
   even with wrapping on — the attribute has to go, not just be capped. */
table[width],td[width],th[width]{width:auto}
td,th{overflow-wrap:anywhere;word-break:normal}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
a{color:#0a58ca;overflow-wrap:break-word}
</style>
${dark ? `<style>
html{filter:invert(1) hue-rotate(180deg);background:#fff}
img,video,picture,svg{filter:invert(1) hue-rotate(180deg)}
</style>` : ""}
</head><body>${html}</body></html>`;
  }, [html, dark]);

  useEffect(() => {
    const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [doc]);

  if (!url) return <div className="email-frame" />;
  // sandbox="" => no scripts, no same-origin, no forms. allow-popups lets a link
  // (if any survived sanitization) open in a new tab without touching our origin.
  return <iframe className="email-frame" title={t("msg.frameTitle")} sandbox="" src={url} referrerPolicy="no-referrer" />;
}
