/** Minimal shapes of the Cloudflare Client API responses MailVault consumes. */

export interface CfZone {
  id: string;
  name: string;
  status: string; // active | pending | moved | deactivated
  type: string; // full | partial
  account?: { id?: string; name?: string } | null;
}

export interface CfDnsRecord {
  id: string;
  type: string; // MX | TXT | CNAME | ...
  name: string;
  content: string;
  priority?: number | null;
  ttl?: number;
  proxiable?: boolean;
}

/** Result of GET /zones/{id}/email/routing — the settings/status object. */
export interface CfEmailRoutingSettings {
  id?: string;
  name?: string;
  enabled?: boolean;
  status?: string; // ready | unconfigured | misconfigured | ...
  skip_wizard?: boolean;
}

/** DNS records the Email Routing feature needs (GET /zones/{id}/email/routing/dns). */
export interface CfEmailRoutingDnsRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
  ttl?: number;
}

/** Ordinary Email Routing rule shape returned by the paginated rules endpoint. */
export interface CfEmailRoutingRule {
  id?: string;
  actions?: Array<{ type?: "drop" | "forward" | "worker"; value?: string[] }>;
  enabled?: boolean;
  matchers?: Array<{ type?: "all" | "literal"; field?: "to"; value?: string }>;
  name?: string;
  priority?: number;
  source?: "api" | "wrangler";
}

/** Catch-all rule shape (PUT/GET /zones/{id}/email/routing/rules/catch_all). */
export interface CfCatchAllAction {
  type: "drop" | "forward" | "worker";
  value?: string[];
}
export interface CfCatchAllRule {
  id?: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  source?: "api" | "wrangler";
  actions?: CfCatchAllAction[];
  matchers?: Array<{ type: string; field?: string; value?: string }>;
  catch_all?: boolean;
}

/**
 * Email Sending. A sending "subdomain" row is Cloudflare's unit of onboarding — the apex
 * counts as one too — and its DNS lives on `cf-bounce.<name>` plus `_dmarc.<name>`, never on
 * the receiving records, which is why enabling sending cannot disturb a domain's MX.
 */
export interface CfSendingRecord {
  name: string;
  type: string;
  content: string;
  priority?: number;
  ttl?: number;
}

/** One problem found while checking the DNS a sending onboarding needs. */
export interface CfSendingIssue {
  code: string;
  missing?: CfSendingRecord;
  existing?: CfSendingRecord;
  multiple?: CfSendingRecord[];
}

export interface CfSendingPreview {
  records: CfSendingRecord[];
  errors: CfSendingIssue[];
}

export interface CfSendingDomain {
  tag: string;
  name: string;
  enabled: boolean;
  return_path_domain?: string;
  dkim_selector?: string;
  created?: string;
  modified?: string;
}

export interface CfError {
  code: number | string;
  message: string;
}

export interface CfEnvelope<T> {
  success: boolean;
  errors: CfError[];
  messages: CfError[];
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    count: number;
    total_count: number;
    total_pages: number;
  };
}
