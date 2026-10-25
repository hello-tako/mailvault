import { getObject } from "../storage/r2";

/**
 * Resolve `cid:` image references into the pixels they name (plan C2): the sanitized HTML
 * keeps them, and the detail route swaps each one for a data URL built from the message's
 * own attachment in R2. Nothing here touches the network — a data URL is the attachment's
 * bytes, so no tracker can ride this path where remote images stay blocked.
 *
 * An image that is missing, not an image, or past the caps is removed rather than left as a
 * broken frame: a blank box teaches the owner that mail images "sometimes" work.
 */

const CID_IMG = /<img\b[^>]*\bsrc="cid:([^"]+)"[^>]*>/gi;
const EACH_CAP = 512 * 1024;
const TOTAL_CAP = 4 * 1024 * 1024;

export interface CidAttachment {
  id: string;
  contentId?: string | null;
  contentType: string;
  size: number;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function embedCidImages(
  html: string,
  attachments: CidAttachment[],
  bucket: R2Bucket,
  r2KeyOf: (attachmentId: string) => Promise<string | null>,
): Promise<string> {
  const byCid = new Map(
    attachments
      .filter((a) => a.contentId)
      .map((a) => [(a.contentId ?? "").replace(/^<|>$/g, "").toLowerCase(), a]),
  );
  const swaps = new Map<string, string>();
  let spent = 0;

  for (const match of html.matchAll(CID_IMG)) {
    const tag = match[0];
    if (swaps.has(tag)) continue;
    const cid = (match[1] ?? "").replace(/^<|>$/g, "").toLowerCase();
    const att = byCid.get(cid);
    if (!att || !att.contentType.startsWith("image/") || att.size > EACH_CAP) {
      swaps.set(tag, "");
      continue;
    }
    const key = await r2KeyOf(att.id);
    const obj = key ? await getObject(bucket, key).catch(() => null) : null;
    if (!obj) {
      swaps.set(tag, "");
      continue;
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (spent + bytes.length > TOTAL_CAP) {
      swaps.set(tag, "");
      continue;
    }
    spent += bytes.length;
    const alt = /\balt="([^"]*)"/i.exec(tag)?.[1]?.replace(/"/g, "&quot;") ?? "";
    swaps.set(tag, `<img src="data:${att.contentType.split(";")[0]};base64,${toBase64(bytes)}" alt="${alt}">`);
  }

  let out = html;
  for (const [from, to] of swaps) out = out.split(from).join(to);
  return out;
}
