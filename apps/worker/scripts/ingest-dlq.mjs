#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const configPath = path.join(repoRoot, "apps/worker/wrangler.jsonc");
const config = readFileSync(configPath, "utf8");

function configValue(section, key) {
  const block = new RegExp(`"${section}"\\s*:\\s*\\[[\\s\\S]*?\\]`).exec(config)?.[0] ?? "";
  const binding =
    section === "d1_databases" ? '"binding"\\s*:\\s*"DB"' : '"binding"\\s*:\\s*"MAIL_BUCKET"';
  const scoped = new RegExp(`${binding}[\\s\\S]*?"${key}"\\s*:\\s*"([^"]+)"`).exec(block);
  return scoped?.[1];
}

export function parseOptions(argv) {
  const options = { replay: false, limit: 5, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--replay") options.replay = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (
      ["--account-id", "--dlq-id", "--queue-id", "--database-id", "--bucket", "--limit"].includes(
        arg,
      )
    ) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("invalid_arguments");
      options[arg.slice(2).replaceAll("-", "_")] = value;
    } else throw new Error("invalid_arguments");
  }
  options.account_id ||= process.env.CF_ACCOUNT_ID;
  options.dlq_id ||= process.env.MAIL_INGEST_DLQ_ID;
  options.queue_id ||= process.env.MAIL_INGEST_QUEUE_ID;
  options.database_id ||= process.env.MAILVAULT_D1_ID || configValue("d1_databases", "database_id");
  options.bucket ||= configValue("r2_buckets", "bucket_name");
  options.limit = Number(options.limit);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("invalid_arguments");
  }
  return options;
}

function queueJob(value) {
  let job = value;
  if (typeof job === "string") {
    try {
      job = JSON.parse(job);
    } catch {
      return null;
    }
  }
  if (
    !job ||
    job.v !== 1 ||
    typeof job.messageId !== "string" ||
    typeof job.dedupeKey !== "string" ||
    typeof job.domainId !== "string" ||
    typeof job.aliasId !== "string" ||
    typeof job.rawKey !== "string" ||
    typeof job.parsedKey !== "string" ||
    typeof job.envelopeFrom !== "string" ||
    typeof job.envelopeTo !== "string" ||
    job.parsedKey !== `parsed/${job.messageId}.json` ||
    !/^[a-z\d-]{1,80}$/i.test(job.messageId) ||
    !/^[a-z\d-]{1,80}$/i.test(job.domainId) ||
    !/^[a-z\d-]{1,80}$/i.test(job.aliasId) ||
    !new RegExp(
      `^raw/${job.domainId}/${job.aliasId}/\\d{4}/\\d{2}/${job.messageId}\\.eml$`,
      "i",
    ).test(job.rawKey)
  ) {
    return null;
  }
  return job;
}

function safeAttachmentKeys(parsed, messageId) {
  if (!parsed || !Array.isArray(parsed.attachments)) return null;
  const keys = [];
  for (const attachment of parsed.attachments) {
    if (
      !attachment ||
      typeof attachment.id !== "string" ||
      !/^[a-z\d-]{1,80}$/i.test(attachment.id) ||
      typeof attachment.r2Key !== "string" ||
      !attachment.r2Key.startsWith(`attachments/${messageId}/`) ||
      attachment.r2Key.slice(`attachments/${messageId}/`.length).includes("/") ||
      attachment.r2Key.includes("..")
    )
      return null;
    keys.push(attachment.r2Key);
  }
  return keys;
}

export function classifyIngest({
  job,
  row,
  attachmentKeys,
  indexedRows,
  objectsPresent,
  stagedValid,
  canonicalComplete,
  canonicalReplayable,
}) {
  if (!job) return { state: "invalid_job", replayable: false };
  if (row && row.id !== job.messageId) {
    if (row.ingest_status === "COMMITTED" && canonicalComplete) {
      return { state: "true_duplicate", replayable: false };
    }
    return canonicalReplayable
      ? { state: "partially_committed", replayable: true }
      : { state: "duplicate_in_progress", replayable: false };
  }
  if (!row) {
    return objectsPresent && stagedValid
      ? { state: "never_committed", replayable: true }
      : { state: "never_committed_staging_missing", replayable: false };
  }
  if (!Array.isArray(attachmentKeys))
    return { state: "partially_committed_staging_invalid", replayable: false };
  const expected = [...attachmentKeys].sort();
  const actual = (row.attachment_keys ?? []).sort();
  const coreComplete =
    row.raw_r2_key === job.rawKey &&
    row.parsed_r2_key === job.parsedKey &&
    Number(row.attachment_count) === expected.length &&
    JSON.stringify(actual) === JSON.stringify(expected) &&
    Number(indexedRows) === 1;
  if (row.ingest_status === "COMMITTED" && coreComplete && objectsPresent && stagedValid) {
    return { state: "fully_committed", replayable: false };
  }
  return {
    state:
      objectsPresent && stagedValid ? "partially_committed" : "partially_committed_staging_missing",
    replayable: Boolean(objectsPresent && stagedValid),
  };
}

async function api(token, url, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new Error("cloudflare_api_unavailable");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("cloudflare_api_invalid_response");
  }
  if (!response.ok || data.success === false || data.errors?.length) {
    throw new Error("cloudflare_api_request_failed");
  }
  return data;
}

function wrangler(args, { capture = false } = {}) {
  const result = spawnSync("pnpm", ["--filter", "@mailvault/worker", "exec", "wrangler", ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: capture ? "utf8" : undefined,
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
  });
  if (result.error || result.status !== 0) return null;
  return capture ? result.stdout : true;
}

function r2Read(bucket, key, capture = false) {
  const mode = capture ? ["--pipe"] : ["--file", "/dev/null"];
  return wrangler(
    ["r2", "object", "get", `${bucket}/${key}`, ...mode, "--remote", "--config", configPath],
    {
      capture,
    },
  );
}

async function queryD1(token, accountId, databaseId, sql, params = [], request = api) {
  const data = await request(
    token,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    { method: "POST", body: JSON.stringify({ sql, params: params.map(String) }) },
  );
  const result = data.result?.[0];
  if (!result?.success) throw new Error("d1_read_failed");
  return result.results ?? [];
}

async function inspect(token, accountId, databaseId, readObject, job, request) {
  const parsedText = readObject(job.parsedKey, true);
  let parsed;
  let attachmentKeys = null;
  let stagedValid = false;
  if (parsedText !== null) {
    try {
      parsed = JSON.parse(parsedText);
      attachmentKeys = safeAttachmentKeys(parsed, job.messageId);
      stagedValid = Array.isArray(attachmentKeys);
    } catch {
      stagedValid = false;
    }
  }
  const rows = await queryD1(
    token,
    accountId,
    databaseId,
    `SELECT id, domain_id, alias_id, dedupe_key, envelope_from, envelope_to,
            raw_r2_key, parsed_r2_key, attachment_count, ingest_status
     FROM messages WHERE id = ?1 OR dedupe_key = ?2`,
    [job.messageId, job.dedupeKey],
    request,
  );
  const row =
    rows.find((item) => item.id === job.messageId) ??
    rows.find((item) => item.dedupe_key === job.dedupeKey) ??
    null;
  const recordId = row?.id ?? job.messageId;
  const [attachments, fts] = await Promise.all([
    queryD1(
      token,
      accountId,
      databaseId,
      `SELECT id, r2_key FROM attachments WHERE message_id = ?1`,
      [recordId],
      request,
    ),
    queryD1(
      token,
      accountId,
      databaseId,
      `SELECT COUNT(*) AS count FROM messages_fts WHERE message_id = ?1`,
      [recordId],
      request,
    ),
  ]);
  const expectedAttachmentKeys = attachmentKeys ?? attachments.map((item) => item.r2_key);
  const objectsPresent = [job.rawKey, job.parsedKey, ...expectedAttachmentKeys].every(
    (key) => readObject(key, false) !== null,
  );
  let canonicalComplete =
    row?.id === job.messageId && objectsPresent && stagedValid && Number(fts[0]?.count ?? 0) === 1;
  let replayJob = job;
  let classificationObjectsPresent = objectsPresent;
  let canonicalObjectsPresent = false;
  let canonicalAttachmentKeys = null;
  if (row && row.id !== job.messageId) {
    const canonicalParsedText =
      typeof row.parsed_r2_key === "string" ? readObject(row.parsed_r2_key, true) : null;
    if (canonicalParsedText !== null) {
      try {
        canonicalAttachmentKeys = safeAttachmentKeys(JSON.parse(canonicalParsedText), row.id);
      } catch {
        canonicalAttachmentKeys = null;
      }
    }
    const canonicalKeys = canonicalAttachmentKeys ?? attachments.map((item) => item.r2_key);
    canonicalObjectsPresent =
      typeof row.raw_r2_key === "string" &&
      typeof row.parsed_r2_key === "string" &&
      [row.raw_r2_key, row.parsed_r2_key, ...canonicalKeys].every(
        (key) => readObject(key, false) !== null,
      );
    const actualKeys = attachments.map((item) => item.r2_key).sort();
    canonicalComplete = Boolean(
      row.ingest_status === "COMMITTED" &&
      canonicalAttachmentKeys &&
      canonicalObjectsPresent &&
      Number(row.attachment_count) === canonicalAttachmentKeys.length &&
      JSON.stringify(actualKeys) === JSON.stringify([...canonicalAttachmentKeys].sort()) &&
      Number(fts[0]?.count ?? 0) === 1,
    );
  }
  let canonicalReplayable = false;
  if (row && row.id !== job.messageId && !canonicalComplete) {
    const canonicalText =
      typeof row.parsed_r2_key === "string" ? readObject(row.parsed_r2_key, true) : null;
    let canonicalParsed;
    if (canonicalText !== null) {
      try {
        canonicalParsed = JSON.parse(canonicalText);
      } catch {
        canonicalParsed = undefined;
      }
    }
    const canonicalEntries = Array.isArray(canonicalParsed?.attachments)
      ? canonicalParsed.attachments
          .filter(
            (attachment) =>
              typeof attachment?.id === "string" && typeof attachment?.r2Key === "string",
          )
          .map((attachment) => `${attachment.id}|${attachment.r2Key}`)
      : null;
    const actualEntries = attachments.map((attachment) => `${attachment.id}|${attachment.r2_key}`);
    const fieldsPresent =
      typeof row.domain_id === "string" &&
      typeof row.alias_id === "string" &&
      typeof row.envelope_from === "string" &&
      typeof row.envelope_to === "string" &&
      typeof row.raw_r2_key === "string" &&
      typeof row.parsed_r2_key === "string";
    const candidate = fieldsPresent
      ? queueJob({
          v: 1,
          messageId: row.id,
          dedupeKey: row.dedupe_key,
          domainId: row.domain_id,
          aliasId: row.alias_id,
          envelopeFrom: row.envelope_from,
          envelopeTo: row.envelope_to,
          rawKey: row.raw_r2_key,
          parsedKey: row.parsed_r2_key,
        })
      : null;
    const attachmentRefsSafe =
      canonicalAttachmentKeys !== null &&
      canonicalEntries !== null &&
      Number(row.attachment_count) === canonicalEntries.length &&
      actualEntries.every((entry) => canonicalEntries.includes(entry));
    if (candidate && canonicalObjectsPresent && attachmentRefsSafe) {
      replayJob = candidate;
      canonicalReplayable = true;
      classificationObjectsPresent = true;
    }
  }
  const classification = classifyIngest({
    job,
    row: row && { ...row, attachment_keys: attachments.map((item) => item.r2_key) },
    attachmentKeys: stagedValid ? attachmentKeys : null,
    indexedRows: fts[0]?.count ?? 0,
    objectsPresent,
    stagedValid,
    canonicalComplete,
    canonicalReplayable,
  });
  return {
    ...classification,
    rowId: row?.id,
    objectsPresent: classificationObjectsPresent,
    replayJob,
  };
}

export async function run(options, dependencies = {}) {
  const token = dependencies.token ?? process.env.CLOUDFLARE_API_TOKEN;
  const request = dependencies.api ?? api;
  const output = dependencies.log ?? console.log;
  if (!token || !options.account_id || !options.dlq_id || !options.database_id || !options.bucket) {
    throw new Error("missing_required_configuration");
  }
  if (options.replay && !options.queue_id) throw new Error("missing_replay_queue_id");
  const base = `https://api.cloudflare.com/client/v4/accounts/${options.account_id}/queues`;
  const peek = await request(token, `${base}/${options.dlq_id}/messages/peek`, {
    method: "POST",
    body: JSON.stringify({ batch_size: options.limit }),
  });
  const messages = peek.result?.messages ?? [];
  let replayed = 0;
  for (const message of messages) {
    const job = queueJob(message.body);
    const readObject =
      dependencies.readR2 ?? ((key, capture) => r2Read(options.bucket, key, capture));
    const result = job
      ? await inspect(token, options.account_id, options.database_id, readObject, job, request)
      : { state: "invalid_job", replayable: false };
    const replay = options.replay && result.replayable && result.objectsPresent;
    if (replay) {
      await request(token, `${base}/${options.queue_id}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: result.replayJob ?? job, content_type: "json" }),
      });
      replayed += 1;
    }
    output(
      `dlq_message=${message.id ?? "unknown"} message=${job?.messageId ?? "invalid"} state=${result.state} replayable=${Boolean(result.replayable && result.objectsPresent)}${replay ? " replayed=yes" : ""}`,
    );
  }
  output(
    `inspected=${messages.length} replayed=${replayed} mode=${options.replay ? "replay" : "dry-run"}`,
  );
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch {
    console.error("Invalid arguments. See --help.");
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(
      "Read-only by default: node apps/worker/scripts/ingest-dlq.mjs [--limit 1..100]. Set CF_ACCOUNT_ID, MAIL_INGEST_DLQ_ID, CLOUDFLARE_API_TOKEN; optional MAILVAULT_D1_ID. Replay requires --replay and MAIL_INGEST_QUEUE_ID. R2 reads are streamed to /dev/null; output contains IDs/states only.",
    );
    return;
  }
  try {
    await run(options);
  } catch {
    console.error("DLQ inspection stopped; no message content or credentials were logged.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
