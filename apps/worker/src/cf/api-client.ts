import type {
  CfCatchAllRule,
  CfDnsRecord,
  CfEmailRoutingDnsRecord,
  CfEmailRoutingRule,
  CfEmailRoutingSettings,
  CfEnvelope,
  CfSendingDomain,
  CfSendingIssue,
  CfSendingPreview,
  CfSendingRecord,
  CfZone,
} from "./types";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_PER_PAGE = 100;
const DEFAULT_TIMEOUT_MS = 20_000;

export type CfErrorKind =
  | "unset_token"
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limited"
  | "network"
  | "upstream"
  | "bad_request";

/** Normalized Cloudflare error. Never contains request headers or the token. */
export class CloudflareApiError extends Error {
  constructor(
    readonly kind: CfErrorKind,
    message: string,
    readonly status?: number,
    readonly cfCodes?: Array<number | string>,
    /** API path (no query, no credentials) — safe to log, pinpoints the failing call. */
    readonly path?: string,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export interface CloudflareClientOptions {
  token?: string;
  accountId?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CloudflareClient {
  hasToken: boolean;
  listAllZones(): Promise<CfZone[]>;
  listDnsRecords(zoneId: string, type?: string): Promise<CfDnsRecord[]>;
  /** Used only by an owner-confirmed MX takeover; the record is audited before deletion. */
  deleteDnsRecord(zoneId: string, recordId: string): Promise<void>;
  getEmailRoutingStatus(zoneId: string): Promise<CfEmailRoutingSettings>;
  getEmailRoutingDns(zoneId: string): Promise<CfEmailRoutingDnsRecord[]>;
  listEmailRoutingRules(zoneId: string): Promise<CfEmailRoutingRule[]>;
  enableEmailRouting(zoneId: string): Promise<void>;
  getCatchAll(zoneId: string): Promise<CfCatchAllRule | null>;
  setCatchAllWorker(zoneId: string, workerName: string): Promise<void>;
  /**
   * The DNS that enabling sending would write, and what stands in its way. Cloudflare
   * documents this endpoint as a read-only dry run, so a confirmation screen can show the
   * exact records before anything changes.
   */
  previewSending(zoneId: string, name: string): Promise<CfSendingPreview>;
  listSendingDomains(zoneId: string): Promise<CfSendingDomain[]>;
  /** Creates the sending row and publishes its own DNS. Never touches the receiving records. */
  enableSending(zoneId: string, name: string): Promise<CfSendingDomain>;
}

type Query = Record<string, string | number | undefined>;

function kindFromStatus(status: number): CfErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream";
  return "bad_request";
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A small, typed REST wrapper around the Cloudflare Client API (sections 31/62).
 * Deliberately avoids the generated SDK so we aren't coupled to stale signatures.
 * This is the ONLY place raw Cloudflare fetches happen — route handlers must go
 * through here. The Authorization header is never logged and never surfaced.
 */
export function createCloudflareClient(options: CloudflareClientOptions): CloudflareClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? defaultSleep;

  function buildUrl(path: string, query?: Query): string {
    const url = new URL(CF_API_BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    return url.toString();
  }

  /** Core request: retries transient failures, normalizes errors, returns full envelope. */
  async function requestEnvelope<T>(
    method: string,
    path: string,
    init: { body?: unknown; query?: Query; retries?: number } = {},
  ): Promise<CfEnvelope<T>> {
    if (!options.token) throw new CloudflareApiError("unset_token", "Cloudflare API token is not configured");
    const url = buildUrl(path, init.query);
    const attempts = (init.retries ?? maxRetries) + 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt < attempts - 1) {
          await sleep(2 ** attempt * 300);
          continue;
        }
        throw new CloudflareApiError("network", "Cloudflare API request failed (network)");
      }

      if ((res.status === 429 || res.status >= 500) && attempt < attempts - 1) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? 0);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 300);
        continue;
      }

      let json: CfEnvelope<T>;
      try {
        json = (await res.json()) as CfEnvelope<T>;
      } catch {
        throw new CloudflareApiError(kindFromStatus(res.status), `Cloudflare returned a non-JSON response (${res.status})`, res.status);
      }

      if (!res.ok || !json.success) {
        throw new CloudflareApiError(
          kindFromStatus(res.status),
          `Cloudflare API error: ${(json.errors ?? [])[0]?.message ?? res.statusText}`,
          res.status,
          (json.errors ?? []).map((e) => e.code),
          path,
        );
      }
      return json;
    }
    throw new CloudflareApiError("upstream", "Cloudflare API request failed after retries");
  }

  const requestResult = async <T>(method: string, path: string, init?: { body?: unknown; query?: Query }) =>
    (await requestEnvelope<T>(method, path, init)).result;

  /** Paginated GET — walks every page and returns the concatenated result array. */
  async function pagedAll<T>(path: string, extra?: Query): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (;;) {
      const env = await requestEnvelope<T[]>("GET", path, {
        query: { per_page: DEFAULT_PER_PAGE, page, ...extra },
      });
      out.push(...(env.result ?? []));
      const info = env.result_info;
      if (!info || page >= info.total_pages || page >= 100) break;
      page++;
    }
    return out;
  }

  return {
    hasToken: !!options.token,

    async listAllZones(): Promise<CfZone[]> {
      const query: Query = options.accountId ? { "account.id": options.accountId } : {};
      const zones = await pagedAll<CfZone>("/zones", query);
      if (!options.accountId) return zones;
      // account.id filter is applied server-side, but keep defensive filter.
      return zones.filter((z) => !z.account?.id || z.account.id === options.accountId);
    },

    async listDnsRecords(zoneId, type): Promise<CfDnsRecord[]> {
      return pagedAll<CfDnsRecord>(`/zones/${zoneId}/dns_records`, type ? { type } : undefined);
    },

    async deleteDnsRecord(zoneId, recordId): Promise<void> {
      await requestResult("DELETE", `/zones/${zoneId}/dns_records/${encodeURIComponent(recordId)}`);
    },

    getEmailRoutingStatus: (zoneId) => requestResult<CfEmailRoutingSettings>("GET", `/zones/${zoneId}/email/routing`),
    getEmailRoutingDns: (zoneId) => requestResult<CfEmailRoutingDnsRecord[]>("GET", `/zones/${zoneId}/email/routing/dns`),

    /**
     * Read every ordinary Email Routing rule before treating catch-all routing as ready.
     * Cloudflare caps this endpoint at 50 rows/page; a bounded complete pagination proof
     * avoids certifying a catch-all while an earlier rule is hidden on a later page.
     */
    async listEmailRoutingRules(zoneId): Promise<CfEmailRoutingRule[]> {
      const out: CfEmailRoutingRule[] = [];
      const seen = new Set<string>();
      const maxPages = 20;
      const perPage = 50;
      let totalPages = 0;
      let totalCount = 0;
      for (let page = 1; page <= maxPages; page++) {
        const envelope = await requestEnvelope<CfEmailRoutingRule[]>("GET", `/zones/${zoneId}/email/routing/rules`, {
          query: { per_page: perPage, page }, retries: 0,
        });
        const info = envelope.result_info;
        const rows = envelope.result;
        const pageCount = info ? Math.max(1, info.total_pages) : 0;
        if (!Array.isArray(rows) || !info || info.page !== page || info.per_page !== perPage ||
          !Number.isInteger(info.count) || !Number.isInteger(info.total_count) || !Number.isInteger(info.total_pages) ||
          info.count !== rows.length || info.count < 0 || info.count > perPage || info.total_count < 0 || info.total_pages < 0 || (info.total_pages === 0 && info.total_count !== 0) || pageCount > maxPages ||
          pageCount !== Math.max(1, Math.ceil(info.total_count / perPage)) ||
          info.total_count < info.count || (page < pageCount && info.count !== perPage) ||
          (page === pageCount && out.length + rows.length !== info.total_count)) {
          throw new CloudflareApiError("upstream", "Cloudflare returned incomplete Email Routing rule pagination", 200, [], `/zones/${zoneId}/email/routing/rules`);
        }
        if (page === 1) { totalPages = pageCount; totalCount = info.total_count; }
        else if (pageCount !== totalPages || info.total_count !== totalCount) {
          throw new CloudflareApiError("upstream", "Cloudflare Email Routing rule pagination changed during verification", 200, [], `/zones/${zoneId}/email/routing/rules`);
        }
        for (const row of rows) {
          if (!row || typeof row !== "object" || typeof row.id !== "string" || row.id.length === 0 || seen.has(row.id)) {
            throw new CloudflareApiError("upstream", "Cloudflare returned malformed Email Routing rules", 200, [], `/zones/${zoneId}/email/routing/rules`);
          }
          seen.add(row.id);
          out.push(row);
        }
        if (page === totalPages) {
          if (out.length !== totalCount) throw new CloudflareApiError("upstream", "Cloudflare Email Routing rule count mismatch", 200, [], `/zones/${zoneId}/email/routing/rules`);
          return out;
        }
      }
      throw new CloudflareApiError("upstream", "Cloudflare Email Routing rules exceed verification bound", 200, [], `/zones/${zoneId}/email/routing/rules`);
    },

    // Adds+locks the Cloudflare MX/SPF records and enables routing.
    // /email/routing/dns (GET/POST) is dashboard-scoped and answers 403 for API
    // tokens; /email/routing/enable is the token-authorized equivalent. It takes an
    // empty JSON body — sending a zone-apex `name` fails with CF error 2007.
    async enableEmailRouting(zoneId) {
      await requestResult("POST", `/zones/${zoneId}/email/routing/enable`, { body: {} });
    },

    async getCatchAll(zoneId): Promise<CfCatchAllRule | null> {
      try {
        return await requestResult<CfCatchAllRule>("GET", `/zones/${zoneId}/email/routing/rules/catch_all`);
      } catch (err) {
        if (err instanceof CloudflareApiError && err.kind === "not_found") return null;
        throw err;
      }
    },

    async setCatchAllWorker(zoneId, workerName) {
      await requestResult("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
        body: {
          actions: [{ type: "worker", value: [workerName] }],
          matchers: [{ type: "all" }],
          enabled: true,
          source: "api",
        },
      });
    },

    async previewSending(zoneId, name): Promise<CfSendingPreview> {
      const r = await requestResult<{ records?: CfSendingRecord[]; errors?: CfSendingIssue[] }>(
        "POST",
        `/zones/${zoneId}/email/sending/subdomains/preview`,
        { body: { name } },
      );
      return { records: r.records ?? [], errors: r.errors ?? [] };
    },

    async listSendingDomains(zoneId): Promise<CfSendingDomain[]> {
      return requestResult<CfSendingDomain[]>("GET", `/zones/${zoneId}/email/sending/subdomains`);
    },

    async enableSending(zoneId, name): Promise<CfSendingDomain> {
      return requestResult<CfSendingDomain>("POST", `/zones/${zoneId}/email/sending/subdomains`, {
        body: { name },
      });
    },
  };
}
