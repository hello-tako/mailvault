import { describe, expect, it } from "vitest";
import { classifyIngest, parseOptions, run } from "../../scripts/ingest-dlq.mjs";

const id = "123e4567-e89b-42d3-a456-426614174000";
const job = {
  messageId: id,
  dedupeKey: "digest",
  domainId: "223e4567-e89b-42d3-a456-426614174001",
  aliasId: "323e4567-e89b-42d3-a456-426614174002",
  rawKey: `raw/223e4567-e89b-42d3-a456-426614174001/323e4567-e89b-42d3-a456-426614174002/2026/10/${id}.eml`,
  parsedKey: `parsed/${id}.json`,
  envelopeFrom: "sender@example.net",
  envelopeTo: "owner@example.net",
  v: 1,
};
const options = {
  replay: false,
  limit: 1,
  help: false,
  account_id: "account",
  dlq_id: "dead-letter",
  queue_id: "ingest",
  database_id: "database",
  bucket: "private-mail",
};

describe("ingest DLQ operator safety", () => {
  it("defaults to read-only dry-run and requires --replay to enable mutation", () => {
    expect(parseOptions([]).replay).toBe(false);
    expect(parseOptions(["--replay"]).replay).toBe(true);
  });

  it("classifies fully committed, partial, never committed, and true duplicates", () => {
    const row = {
      id,
      raw_r2_key: job.rawKey,
      parsed_r2_key: job.parsedKey,
      attachment_count: 0,
      ingest_status: "COMMITTED",
      attachment_keys: [],
    };
    const common = {
      job,
      row,
      attachmentKeys: [],
      indexedRows: 1,
      objectsPresent: true,
      stagedValid: true,
      canonicalComplete: true,
    };
    expect(classifyIngest(common)).toEqual({ state: "fully_committed", replayable: false });
    expect(classifyIngest({ ...common, row: { ...row, ingest_status: "RULES_PENDING" } })).toEqual({
      state: "partially_committed",
      replayable: true,
    });
    expect(classifyIngest({ ...common, row: null })).toEqual({
      state: "never_committed",
      replayable: true,
    });
    expect(
      classifyIngest({
        ...common,
        row: { ...row, id: "423e4567-e89b-42d3-a456-426614174003" },
      }),
    ).toEqual({ state: "true_duplicate", replayable: false });
    expect(
      classifyIngest({
        ...common,
        row: { ...row, id: "423e4567-e89b-42d3-a456-426614174003" },
        canonicalComplete: false,
      }),
    ).toEqual({ state: "duplicate_in_progress", replayable: false });
    expect(
      classifyIngest({
        ...common,
        row: { ...row, id: "423e4567-e89b-42d3-a456-426614174003", ingest_status: "RULES_PENDING" },
        canonicalComplete: false,
        canonicalReplayable: true,
      }),
    ).toEqual({ state: "partially_committed", replayable: true });
  });

  it("peeks and inspects in default mode without pushing to the ingest queue or logging content", async () => {
    const requests: string[] = [];
    const output: string[] = [];
    const parsed = JSON.stringify({
      subject: "private subject",
      text: "private body",
      attachments: [],
    });
    const api = async (
      _token: string,
      url: string,
      init: { method?: string; body?: string } = {},
    ) => {
      requests.push(`${init.method ?? "GET"} ${url}`);
      if (url.endsWith("/messages/peek"))
        return { result: { messages: [{ id: "dlq-id", body: job }] } };
      if (url.includes("/d1/")) {
        const sql = JSON.parse(init.body ?? "{}").sql;
        if (sql.includes("FROM messages WHERE")) {
          return {
            result: [
              {
                success: true,
                results: [
                  {
                    id,
                    raw_r2_key: job.rawKey,
                    parsed_r2_key: job.parsedKey,
                    attachment_count: 0,
                    ingest_status: "COMMITTED",
                  },
                ],
              },
            ],
          };
        }
        if (sql.includes("FROM attachments")) return { result: [{ success: true, results: [] }] };
        return { result: [{ success: true, results: [{ count: 1 }] }] };
      }
      throw new Error("unexpected_mutating_request");
    };
    const readR2 = (key: string, capture: boolean) =>
      key === job.parsedKey && capture ? parsed : true;

    await run(options, { token: "test-token", api, readR2, log: (line) => output.push(line) });

    expect(requests.some((request) => request.includes("/messages/peek"))).toBe(true);
    expect(requests.some((request) => request.endsWith("/messages"))).toBe(false);
    expect(output.join("\n")).not.toContain("private subject");
    expect(output.join("\n")).not.toContain("private body");
    expect(output.join("\n")).not.toContain("sender@example.net");
    expect(output.join("\n")).toContain("state=fully_committed");
  });

  it("only pushes a replay when explicit mutation mode is selected", async () => {
    const requests: string[] = [];
    const api = async (_token: string, url: string) => {
      requests.push(url);
      if (url.endsWith("/messages/peek"))
        return { result: { messages: [{ id: "dlq-id", body: job }] } };
      if (url.includes("/d1/")) return { result: [{ success: true, results: [] }] };
      return { success: true };
    };
    const readR2 = (key: string, capture: boolean) =>
      key === job.parsedKey && capture ? JSON.stringify({ attachments: [] }) : true;
    await run(
      { ...options, replay: true },
      { token: "test-token", api, readR2, log: () => undefined },
    );
    expect(requests.some((request) => request.endsWith("/queues/ingest/messages"))).toBe(true);
  });

  it("replays the persisted canonical job, not a loser job, when a duplicate row is partial", async () => {
    const canonicalId = "bloomviewshare";
    const canonicalJob = {
      ...job,
      messageId: canonicalId,
      rawKey: `raw/${job.domainId}/${job.aliasId}/2026/10/${canonicalId}.eml`,
      parsedKey: `parsed/${canonicalId}.json`,
    };
    let pushed: { body: typeof job } | undefined;
    const api = async (
      _token: string,
      url: string,
      init: { method?: string; body?: string } = {},
    ) => {
      if (url.endsWith("/messages/peek")) {
        return { result: { messages: [{ id: "dlq-id", body: job }] } };
      }
      if (url.includes("/d1/")) {
        const sql = JSON.parse(init.body ?? "{}").sql;
        if (sql.includes("FROM messages WHERE")) {
          return {
            result: [
              {
                success: true,
                results: [
                  {
                    id: canonicalId,
                    domain_id: job.domainId,
                    alias_id: job.aliasId,
                    dedupe_key: job.dedupeKey,
                    envelope_from: job.envelopeFrom,
                    envelope_to: job.envelopeTo,
                    raw_r2_key: canonicalJob.rawKey,
                    parsed_r2_key: canonicalJob.parsedKey,
                    attachment_count: 0,
                    ingest_status: "RULES_PENDING",
                  },
                ],
              },
            ],
          };
        }
        if (sql.includes("FROM attachments")) return { result: [{ success: true, results: [] }] };
        return { result: [{ success: true, results: [{ count: 0 }] }] };
      }
      pushed = JSON.parse(init.body ?? "{}");
      return { success: true };
    };
    const readR2 = (key: string, capture: boolean) => {
      if (capture && key === job.parsedKey) return JSON.stringify({ attachments: [] });
      if (capture && key === canonicalJob.parsedKey) return JSON.stringify({ attachments: [] });
      return true;
    };

    await run(
      { ...options, replay: true },
      { token: "test-token", api, readR2, log: () => undefined },
    );

    expect(pushed?.body.messageId).toBe(canonicalId);
    expect(pushed?.body.messageId).not.toBe(job.messageId);
  });
});
