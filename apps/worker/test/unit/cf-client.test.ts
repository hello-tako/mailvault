import { describe, expect, it } from "vitest";
import { createCloudflareClient } from "../../src/cf/api-client";

interface Sent {
  url: string;
  method?: string;
  body: unknown;
  headers: Record<string, string>;
}

function recordingFetch(sent: Sent[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method,
      body: init?.body ?? null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const TOKEN = "test-token-value";
const ZONE = "92537bc48261d3b53ab25eaa4cab2c90";

describe("Cloudflare client request shapes", () => {
  it("enables Email Routing via the token-authorized endpoint with an empty body", async () => {
    const sent: Sent[] = [];
    const client = createCloudflareClient({ token: TOKEN, fetch: recordingFetch(sent) });

    await client.enableEmailRouting(ZONE);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("POST");
    // /email/routing/dns answers 403 for API tokens; /enable is the token path.
    expect(sent[0]!.url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/email/routing/enable`);
    // A zone-apex `name` here fails with CF 2007, so the body carries no domain.
    expect(JSON.parse(String(sent[0]!.body))).toEqual({});
  });

  it("points the catch-all at our worker", async () => {
    const sent: Sent[] = [];
    const client = createCloudflareClient({ token: TOKEN, fetch: recordingFetch(sent) });

    await client.setCatchAllWorker(ZONE, "mail-vault");

    expect(sent[0]!.method).toBe("PUT");
    expect(sent[0]!.url).toContain(`/zones/${ZONE}/email/routing/rules/catch_all`);
    expect(JSON.parse(String(sent[0]!.body))).toMatchObject({
      actions: [{ type: "worker", value: ["mail-vault"] }],
      matchers: [{ type: "all" }],
      enabled: true,
    });
  });

  it("authenticates by header only — the token never appears in the URL", async () => {
    const sent: Sent[] = [];
    const client = createCloudflareClient({ token: TOKEN, accountId: "acct1", fetch: recordingFetch(sent) });

    await client.listAllZones();
    await client.listDnsRecords(ZONE, "MX");

    for (const s of sent) {
      expect(s.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(s.url).not.toContain(TOKEN);
    }
    expect(sent[0]!.url).toContain("account.id=acct1");
    expect(sent[1]!.url).toContain("type=MX");
  });
});

const routingRule = (id: string) => ({ id, enabled: true,
  actions: [{ type: "worker", value: ["mail-vault"] }], matchers: [{ type: "literal", field: "to", value: "fixture@example.test" }] });
const pageInfo = (count: number, total = count, page = 1) => ({ page, per_page: 50, count, total_count: total, total_pages: Math.max(1, Math.ceil(total / 50)) });

describe("bounded complete Email Routing rule verification", () => {
  it("reads complete pages using the documented 50-row GET limit", async () => {
    const sent: string[] = [];
    const client = createCloudflareClient({ token: TOKEN, fetch: (async (input, init) => {
      sent.push(String(input));
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const page = Number(new URL(String(input)).searchParams.get("page"));
      const rows = page === 1 ? Array.from({ length: 50 }, (_, index) => routingRule(`rule-${index}`)) : [routingRule("rule-50")];
      return Response.json({ success: true, result: rows, result_info: pageInfo(rows.length, 51, page) });
    }) as typeof fetch });
    expect(await client.listEmailRoutingRules(ZONE)).toHaveLength(51);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("per_page=50&page=1");
    expect(sent[1]).toContain("per_page=50&page=2");
    expect(sent.some((url) => url.includes(TOKEN))).toBe(false);
  });

  it.each([
    { result: [], result_info: undefined },
    { result: {}, result_info: pageInfo(0) },
    { result: [routingRule("r")], result_info: pageInfo(0) },
    { result: [], result_info: { ...pageInfo(0), page: 2 } },
    { result: [], result_info: { ...pageInfo(0), per_page: 100 } },
    { result: [], result_info: { ...pageInfo(0), total_pages: 21, total_count: 1050 } },
    { result: [], result_info: { ...pageInfo(0), total_count: 1 } },
    { result: [], result_info: { ...pageInfo(0), total_count: 51, total_pages: 2 } },
    { result: [{}], result_info: pageInfo(1) },
    { result: [routingRule("r"), routingRule("r")], result_info: pageInfo(2) },
  ])("fails closed for incomplete, excessive or malformed pagination %#", async (envelope) => {
    let calls = 0;
    const client = createCloudflareClient({ token: TOKEN, fetch: (async () => {
      calls++;
      return Response.json({ success: true, ...envelope });
    }) as typeof fetch });
    await expect(client.listEmailRoutingRules(ZONE)).rejects.toThrow(/Email Routing/);
    expect(calls).toBe(1);
  });

  it.each(["duplicate", "changed-count", "changed-pages"])("rejects %s across pages", async (failure) => {
    let calls = 0;
    const client = createCloudflareClient({ token: TOKEN, fetch: (async () => {
      calls++;
      const rows = calls === 1 ? Array.from({ length: 50 }, (_, index) => routingRule(`rule-${index}`)) : [routingRule(failure === "duplicate" ? "rule-0" : "rule-50")];
      const info = pageInfo(rows.length, 51, calls);
      if (calls === 2 && failure === "changed-count") info.total_count = 52;
      if (calls === 2 && failure === "changed-pages") info.total_pages = 3;
      return Response.json({ success: true, result: rows, result_info: info });
    }) as typeof fetch });
    await expect(client.listEmailRoutingRules(ZONE)).rejects.toThrow(/Email Routing/);
    expect(calls).toBe(2);
  });

  it("accepts a complete empty inventory with zero total pages", async () => {
    const client = createCloudflareClient({ token: TOKEN, fetch: (async () => Response.json({ success: true,
      result: [], result_info: { ...pageInfo(0), total_pages: 0 } })) as typeof fetch });
    expect(await client.listEmailRoutingRules(ZONE)).toEqual([]);
  });
});
