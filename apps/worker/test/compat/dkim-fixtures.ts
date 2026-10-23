import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/**
 * Test-only DKIM signer (RFC 6376 relaxed/relaxed, RFC 8463 Ed25519). Keys are generated per
 * run, so no key material is committed. It exists only to produce inputs for the verifier.
 */
export type DkimAlgorithm = "rsa-sha256" | "rsa-sha1" | "ed25519-sha256";

export interface DkimKey {
  readonly algorithm: DkimAlgorithm;
  readonly domain: string;
  readonly selector: string;
  readonly privateKey: KeyObject;
  /** TXT record body published at `dkimDnsName(key)`. */
  readonly txt: string;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function createDkimKey(
  algorithm: DkimAlgorithm,
  selector = "sel",
  domain = "example.test",
): DkimKey {
  if (algorithm === "ed25519-sha256") {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    return {
      algorithm,
      domain,
      selector,
      privateKey,
      txt: `v=DKIM1; k=ed25519; p=${toBase64(raw)}`,
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = toBase64(publicKey.export({ format: "der", type: "spki" }));
  return { algorithm, domain, selector, privateKey, txt: `v=DKIM1; k=rsa; p=${spki}` };
}

export function dkimDnsName(key: Pick<DkimKey, "selector" | "domain">): string {
  return `${key.selector}._domainkey.${key.domain}`;
}

function relaxedHeader(line: string): string {
  const colon = line.indexOf(":");
  const name = line.slice(0, colon).toLowerCase();
  const value = line
    .slice(colon + 1)
    .replace(/\r\n(?=[ \t])/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return `${name}:${value}`;
}

function relaxedBody(body: string): string {
  const lines = body.split("\r\n").map((line) => line.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => `${line}\r\n`).join("");
}

export interface SignInput {
  /** Header lines without CRLF, in message order. */
  readonly headers: readonly string[];
  /** CRLF-terminated body. */
  readonly body: string;
  readonly signedHeaders?: readonly string[];
  /** Signs only the first `bodyLength` bytes of the canonical body, as the RFC 6376 `l=` tag does. */
  readonly bodyLength?: number;
}

export function signMessage(
  key: DkimKey,
  { headers, body, signedHeaders = ["from", "to", "subject", "date"], bodyLength }: SignInput,
): string {
  // rsa-sha1 uses SHA-1 for both the body hash and the signature, as RFC 6376 requires.
  const hash = key.algorithm === "rsa-sha1" ? "sha1" : "sha256";
  const canonical = relaxedBody(body);
  const covered = bodyLength === undefined ? canonical : canonical.slice(0, bodyLength);
  const bodyHash = toBase64(createHash(hash).update(covered).digest());
  const lengthTag = bodyLength === undefined ? "" : ` l=${bodyLength};`;
  const unsigned = `v=1; a=${key.algorithm}; c=relaxed/relaxed; d=${key.domain}; s=${key.selector}; h=${signedHeaders.join(":")};${lengthTag} bh=${bodyHash}; b=`;
  const dkimLine = `DKIM-Signature: ${unsigned}`;

  const signedLines = signedHeaders.map((name) => {
    const line = headers.find((h) => h.slice(0, h.indexOf(":")).toLowerCase() === name);
    if (!line) throw new Error(`fixture is missing the signed header ${name}`);
    return `${relaxedHeader(line)}\r\n`;
  });
  const input = `${signedLines.join("")}${relaxedHeader(dkimLine)}`;

  const signature =
    key.algorithm === "ed25519-sha256"
      ? sign(null, createHash("sha256").update(input).digest(), key.privateKey)
      : sign(hash, Buffer.from(input), key.privateKey);

  const headerBlock = [`${dkimLine}${toBase64(signature)}`, ...headers].join("\r\n");
  return `${headerBlock}\r\n\r\n${body}`;
}

/** Flips the low bit of the first signature byte, leaving every other byte of the message intact. */
export function flipSignatureBit(raw: string): string {
  return raw.replace(/(; b=)([A-Za-z0-9+/=]+)/, (_match, prefix: string, b64: string) => {
    const bytes = Buffer.from(b64, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    return prefix + toBase64(bytes);
  });
}

/**
 * A controlled TXT resolver for the verifier. A name with no record fails the way a missing
 * record does. `queries` shows when DNS was used, and `answers` can be edited to model a DNS change.
 */
export function controlledTxtResolver(
  keys: readonly DkimKey[],
  overrides: Record<string, string[][]> = {},
) {
  const answers: Record<string, string[][]> = {
    ...Object.fromEntries(keys.map((key): [string, string[][]] => [dkimDnsName(key), [[key.txt]]])),
    ...overrides,
  };
  const queries: string[] = [];
  const resolveTxt = async (name: string): Promise<string[][]> => {
    queries.push(name);
    const answer = answers[name];
    if (!answer) throw Object.assign(new Error(`no TXT record for ${name}`), { code: "ENOTFOUND" });
    return answer;
  };
  return { resolveTxt, queries, answers };
}
