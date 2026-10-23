import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dkimVerify } from "mailauth/lib/dkim/verify";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDkimKey,
  dkimDnsName,
  flipSignatureBit,
  signMessage,
  type DkimKey,
} from "./dkim-fixtures";

/**
 * Proves that the pinned, patched mailauth DKIM verifier runs inside workerd with production's
 * compatibility settings, and that it agrees with Node. It certifies RSA and Ed25519
 * verification only; nothing here connects DKIM results to live ingest.
 */

interface Outcome {
  result: string;
  comment: string | null;
  algorithm: string | null;
}

type DnsMap = Record<string, string[][]>;

interface Case {
  name: string;
  message: string;
  dns: DnsMap;
  expected: Outcome;
}

const WORKER_ROOT = new URL("../../", import.meta.url);

function readJsonc(url: URL): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(fileURLToPath(url), readFileSync(url, "utf8"));
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  return parsed.config as Record<string, unknown>;
}

function publish(key: DkimKey): DnsMap {
  return { [dkimDnsName(key)]: [[key.txt]] };
}

const headers = [
  "From: Joe <joe@example.test>",
  "To: suzie@example.net",
  "Subject: Synthetic compatibility control",
  "Date: Thu, 08 Oct 2026 00:00:00 +0000",
];
const body = "Benign signed test body.\r\n";

const rsa = createDkimKey("rsa-sha256");
const rsaSha1 = createDkimKey("rsa-sha1");
const ed25519 = createDkimKey("ed25519-sha256");
const validRsa = signMessage(rsa, { headers, body });

const CASES: Case[] = [
  {
    name: "RSA-SHA256 valid signature passes",
    message: validRsa,
    dns: publish(rsa),
    expected: { result: "pass", comment: null, algorithm: "rsa-sha256" },
  },
  {
    name: "RSA-SHA256 signature bit flip fails",
    message: flipSignatureBit(validRsa),
    dns: publish(rsa),
    expected: { result: "fail", comment: "bad signature", algorithm: "rsa-sha256" },
  },
  {
    name: "RSA-SHA256 body tamper fails",
    message: validRsa.replace("Benign signed", "Malign signed"),
    dns: publish(rsa),
    expected: { result: "fail", comment: "body hash did not verify", algorithm: "rsa-sha256" },
  },
  {
    name: "RSA-SHA256 From tamper fails",
    message: validRsa.replace("joe@example.test", "eve@example.test"),
    dns: publish(rsa),
    expected: { result: "fail", comment: "bad signature", algorithm: "rsa-sha256" },
  },
  {
    name: "RSA-SHA256 wrong public key fails",
    message: validRsa,
    dns: { [dkimDnsName(rsa)]: [[createDkimKey("rsa-sha256").txt]] },
    expected: { result: "fail", comment: "bad signature", algorithm: "rsa-sha256" },
  },
  {
    name: "RSA-SHA256 wrong selector does not verify",
    message: validRsa,
    dns: { [`other._domainkey.${rsa.domain}`]: [[rsa.txt]] },
    expected: { result: "neutral", comment: "no key", algorithm: "rsa-sha256" },
  },
  {
    name: "RSA-SHA1 is refused by policy",
    message: signMessage(rsaSha1, { headers, body }),
    dns: publish(rsaSha1),
    expected: { result: "policy", comment: "weak algorithm", algorithm: "rsa-sha1" },
  },
  {
    name: "Ed25519-SHA256 valid signature passes",
    message: signMessage(ed25519, { headers, body }),
    dns: publish(ed25519),
    expected: { result: "pass", comment: null, algorithm: "ed25519-sha256" },
  },
  {
    name: "Ed25519-SHA256 signature bit flip fails",
    message: flipSignatureBit(signMessage(ed25519, { headers, body })),
    dns: publish(ed25519),
    expected: { result: "fail", comment: "bad signature", algorithm: "ed25519-sha256" },
  },
];

function noRecord(name: string, type: string): never {
  throw Object.assign(new Error(`no ${type} record for ${name}`), { code: "ENOTFOUND" });
}

async function verifyInNode(message: string, dns: DnsMap): Promise<Outcome[]> {
  const verified = await dkimVerify(message, {
    strict: true,
    rejectRsaSha1: true,
    resolver: async (name, type) => (type === "TXT" && dns[name]) || noRecord(name, type),
  });
  return verified.results.map((r) => ({
    result: r.status.result,
    comment: r.status.comment ?? null,
    algorithm: r.algo ?? null,
  }));
}

/** Plain node:http, not global fetch: other suites stub fetch and do not always restore it. */
function httpCall(
  url: string,
  method: "GET" | "POST",
  payload?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method, headers: payload === undefined ? {} : { "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}

async function verifyInWorkerd(url: string, message: string, dns: DnsMap): Promise<Outcome[]> {
  const response = await httpCall(url, "POST", { message, dns });
  expect(response.status).toBe(200);
  return (JSON.parse(response.body) as { results: Outcome[] }).results;
}

async function isHarnessReady(url: string): Promise<boolean> {
  try {
    const response = await httpCall(url, "GET");
    return response.status === 200 && JSON.parse(response.body).ready === true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}

interface Harness {
  url: string;
  stop(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const port = await freePort();
  const wrangler = fileURLToPath(new URL("node_modules/wrangler/bin/wrangler.js", WORKER_ROOT));
  const child = spawn(
    process.execPath,
    [wrangler, "dev", "--config", "wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port)],
    {
      cwd: fileURLToPath(new URL("./", import.meta.url)),
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout?.on("data", (chunk: Buffer) => (logs += chunk));
  child.stderr?.on("data", (chunk: Buffer) => (logs += chunk));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited before ready:\n${logs}`);
    if (await isHarnessReady(url)) return { url, stop: () => stopChild(child) };
    if (Date.now() > deadline) {
      await stopChild(child);
      throw new Error(`harness did not become ready:\n${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await startHarness();
}, 90_000);

afterAll(async () => {
  await harness?.stop();
});

describe("patched mailauth DKIM verification under workerd", () => {
  it.each(CASES)("$name", async ({ message, dns, expected }) => {
    const workerd = await verifyInWorkerd(harness!.url, message, dns);
    expect(workerd).toEqual([expected]);
    expect(await verifyInNode(message, dns)).toEqual(workerd);
  });
});

describe("mailauth pin, patch and Worker runtime guards", () => {
  it("pins mailauth exactly and records the patch in the pnpm workspace", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", WORKER_ROOT), "utf8"));
    expect(pkg.dependencies.mailauth).toBe("7.1.1");
    const workspace = readFileSync(
      new URL("../../../../pnpm-workspace.yaml", import.meta.url),
      "utf8",
    );
    expect(workspace).toContain(
      "patchedDependencies:\n  mailauth@7.1.1: patches/mailauth@7.1.1.patch",
    );
  });

  it("runs the installed 7.1.1 package with the RSA digest patch applied", () => {
    const installed = new URL("node_modules/mailauth/", WORKER_ROOT);
    const version = JSON.parse(readFileSync(new URL("package.json", installed), "utf8")).version;
    expect(version).toBe("7.1.1");
    const verifier = readFileSync(new URL("lib/dkim/dkim-verifier.js", installed), "utf8");
    expect(verifier).toContain(
      "signatureHeader.signAlgo === 'rsa' ? signatureHeader.hashAlgo : null,",
    );
    expect(verifier).not.toContain(
      "signatureHeader.signAlgo === 'rsa' ? signatureHeader.algorithm : null,",
    );
  });

  it("keeps the reviewed runtime: date 2026-07-02, nodejs_compat, and the harness in step", () => {
    const production = readJsonc(new URL("wrangler.jsonc", WORKER_ROOT));
    const harnessConfig = readJsonc(new URL("./wrangler.jsonc", import.meta.url));
    expect(production.compatibility_date).toBe("2026-07-02");
    expect(production.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(harnessConfig.compatibility_date).toBe(production.compatibility_date);
    expect(harnessConfig.compatibility_flags).toEqual(production.compatibility_flags);
  });
});
