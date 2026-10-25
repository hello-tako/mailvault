import type {
  AddressReuse,
  Alias,
  AliasDetail,
  AuthPolicy,
  BulkMessageAction,
  BulkMessageResult,
  ComposeInput,
  CreateAliasInput,
  CreatePortalLinkInput,
  DashboardStats,
  Domain,
  DriftReport,
  Health,
  MessageDetail,
  MessageListQuery,
  MessageCounters,
  Paginated,
  Passkey,
  PortalLink,
  PortalLinkCreated,
  PreflightResult,
  ProvisionOutcome,
  PushOutcome,
  MessageSummary,
  Rule,
  RuleAction,
  RuleMatch,
  RecipientSuggestion,
  ReplyInput,
  ImportAliasesInput,
  ImportAliasesResult,
  ForwardInput,
  SendOutcome,
  SendingPreview,
  UpdateAliasInput,
} from "@mailvault/shared";
import { grantHeaders } from "./grant";

/**
 * WebAuthn option objects as they travel over the wire. The browser types for them are
 * tied to `BufferSource`, which is not what JSON carries, so they stay loose here and the
 * WebAuthn library does the conversion at the boundary.
 */
export interface PasskeyOptions {
  options: unknown;
  challenge: string;
}

export interface StepUpOptions {
  options: unknown;
  challenge: string;
}

export interface SecurityStatus {
  passkeys: Passkey[];
  enrolled: boolean;
  rpId: string | null;
}

const BASE = "/api";

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON (shouldn't happen); fall through to error below */
    }
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? "ERROR",
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return body as T;
}

// The Worker requires this custom header on state-changing calls as a CSRF signal, and
// looks for the step-up grant on the ones that cannot be undone.
/** A send still waiting for its moment (B6). */
export interface ScheduledSend {
  id: string;
  kind: string;
  sendAt: string;
  subject: string | null;
  to: string | null;
}

/** An address the owner chose to keep (B10). */
export interface Contact {
  id: string;
  address: string;
  name: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A draft as the vault keeps it (B4). */
export interface Draft {
  id: string;
  fromAddress: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  text: string | null;
  replyToMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One browser holding a push subscription (D4). */
export interface PushDevice {
  id: string;
  label: string | null;
  userAgent: string | null;
  fails: number;
  lastOkAt: string | null;
  createdAt: string;
}

/** Which mail may interrupt (D1). Mirrors the worker's notification_prefs row. */
export interface NotificationPref {
  id: string;
  scopeType: "alias" | "sender_domain";
  scopeValue: string;
  action: "all" | "mute";
}

function mutation(body?: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", "x-mailvault": "1", ...grantHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function sendingMutation(body: unknown, key: string): RequestInit {
  const init = mutation(body);
  return { ...init, headers: { ...init.headers, "Idempotency-Key": key } };
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const api = {
  health: () => request<Health>("/health"),
  dashboard: () => request<DashboardStats>("/dashboard"),

  listDomains: () => request<{ items: Domain[] }>("/domains"),
  syncDomains: () =>
    request<{ discovered: number; autoProvisioned: string[]; items: Domain[] }>(
      "/domains/sync",
      mutation(),
    ),
  /** The one button (W6): token doctor → receiving → first alias → sending → verify. */
  domainSetupRun: (zoneId: string, primaryLocal?: string) =>
    request<{ steps: Array<{ id: string; status: string; detail: string }>; ok: boolean }>(
      `/domains/${encodeURIComponent(zoneId)}/setup-run`,
      mutation({ primaryLocal }),
    ),
  domainTokenReport: (zoneId: string) =>
    request<{ checks: Array<{ capability: string; ok: boolean; permission: string }> }>(
      `/domains/${encodeURIComponent(zoneId)}/token-report`,
    ),

  /** Merge a zone's duplicate SPF records (W3): confirm + passkey, one new record. */
  mergeSpf: (zoneId: string) =>
    request<{ merged: boolean; content?: string; reason?: string }>(
      `/domains/${encodeURIComponent(zoneId)}/spf-merge`,
      mutation({ confirm: true }),
    ),

  /** Send a probe letter to a fresh alias on this domain (W4/A8). */
  sendSetupProbe: (zoneId: string) =>
    request<{ probeAddress: string; aliasId: string; sentAt: string }>(
      `/domains/${encodeURIComponent(zoneId)}/probe`,
      mutation({}),
    ),
  setupProbeStatus: (zoneId: string, aliasId: string) =>
    request<{ arrived: boolean; messageId?: string }>(
      `/domains/${encodeURIComponent(zoneId)}/probe?aliasId=${encodeURIComponent(aliasId)}`,
    ),

  /** The Mail Setup wizard's one-read diagnosis (W1): read-only, ordered next steps. */
  domainSetup: (zoneId: string) =>
    request<Record<string, unknown>>(`/domains/${encodeURIComponent(zoneId)}/setup`),

  /** Opt-in: Sync may itself enable mail on newly discovered zones preflight clears. */
  getAutoProvision: () => request<{ enabled: boolean }>("/domains/auto-provision"),
  setAutoProvision: (enabled: boolean) =>
    request<{ enabled: boolean }>("/domains/auto-provision", mutation({ enabled })),
  verifyDomains: () =>
    request<{ report: DriftReport; items: Domain[] }>("/domains/verify", mutation()),
  preflightDomains: (zoneIds: string[]) =>
    request<{ results: PreflightResult[] }>("/domains/preflight", mutation({ zoneIds })),
  /** Both takeover flags are explicit, per-request confirmations of a destructive change. */
  provisionDomains: (
    zoneIds: string[],
    flags: { allowCatchAllTakeover?: boolean; allowMxTakeover?: boolean } = {},
  ) =>
    request<{ results: ProvisionOutcome[] }>(
      "/domains/provision",
      mutation({
        zoneIds,
        allowCatchAllTakeover: flags.allowCatchAllTakeover ?? false,
        allowMxTakeover: flags.allowMxTakeover ?? false,
      }),
    ),
  retryDomain: (zoneId: string, allowCatchAllTakeover = false) =>
    request<ProvisionOutcome>(
      `/domains/${encodeURIComponent(zoneId)}/retry`,
      mutation({ allowCatchAllTakeover }),
    ),
  removeDomain: (zoneId: string) =>
    request<{ removed: boolean }>(
      `/domains/${encodeURIComponent(zoneId)}`,
      mutation(undefined, "DELETE"),
    ),
  setAuthPolicy: (zoneId: string, policy: AuthPolicy) =>
    request<{ zoneId: string; authPolicy: AuthPolicy }>(
      `/domains/${encodeURIComponent(zoneId)}/auth-policy`,
      mutation({ policy }, "PATCH"),
    ),

  listAliases: (q?: string, view: "all" | "active" | "archived" = "active") =>
    request<{ items: Alias[] }>(`/aliases${qs({ q, view })}`),
  getAlias: (id: string) => request<AliasDetail>(`/aliases/${encodeURIComponent(id)}`),
  updateAlias: (id: string, patch: UpdateAliasInput) =>
    request<Alias>(`/aliases/${encodeURIComponent(id)}`, mutation(patch, "PATCH")),
  createAlias: (input: CreateAliasInput) => request<Alias>("/aliases", mutation(input)),
  /** Add back what an export wrote — additive only, and the answer says exactly what landed. */
  importAliases: (input: ImportAliasesInput) =>
    request<ImportAliasesResult>("/aliases/import", mutation(input)),
  enableAlias: (id: string) =>
    request<Alias>(`/aliases/${encodeURIComponent(id)}/enable`, mutation()),
  disableAlias: (id: string) =>
    request<Alias>(`/aliases/${encodeURIComponent(id)}/disable`, mutation()),
  deleteAlias: (id: string, purgeMessages: boolean) =>
    request<{ deleted: boolean; state?: string }>(
      `/aliases/${encodeURIComponent(id)}`,
      mutation({ purgeMessages }, "DELETE"),
    ),

  /**
   * Portal links for one alias. `create` is the only call that ever returns the token, so the
   * list below can show a link's whole life without being able to rebuild any of them.
   */
  listPortalLinks: (id: string) =>
    request<{ items: PortalLink[] }>(`/aliases/${encodeURIComponent(id)}/portal-links`),
  createPortalLink: (id: string, input: CreatePortalLinkInput) =>
    request<PortalLinkCreated>(`/aliases/${encodeURIComponent(id)}/portal-links`, mutation(input)),
  revokePortalLink: (id: string, grantId: string) =>
    request<{ revoked: boolean }>(
      `/aliases/${encodeURIComponent(id)}/portal-links/${encodeURIComponent(grantId)}`,
      mutation(undefined, "DELETE"),
    ),

  listMessages: (query: Partial<MessageListQuery>) =>
    request<Paginated<MessageSummary> & { nextCursor: string | null }>(`/messages${qs({ ...query })}`),
  /** One conversation: received and sent rows interleaved, oldest first. */
  thread: (id: string) =>
    request<{ id: string; items: MessageSummary[] }>(`/threads/${encodeURIComponent(id)}`),
  getMessage: (id: string, remoteImages = false) =>
    request<MessageDetail>(
      `/messages/${encodeURIComponent(id)}${qs({ remoteImages: remoteImages ? "1" : "" })}`,
    ),
  setMessageRead: (id: string, isRead: boolean) =>
    request<{ id: string; isRead: boolean }>(`/messages/${encodeURIComponent(id)}/read`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-mailvault": "1" },
      body: JSON.stringify({ isRead }),
    }),

  /** Tab and mailbox badges, counted over the whole mailbox rather than the current page. */
  messageCounters: (domainId?: string) =>
    request<MessageCounters>(`/messages/counters${qs({ domainId })}`),
  /**
   * One action over a selection. Also how a single star toggles: a second endpoint for the
   * same flag flip would be two places to keep in step for no gain.
   */
  bulkMessages: (ids: string[], action: BulkMessageAction) =>
    request<BulkMessageResult>("/messages/bulk", mutation({ ids, action })),
  deleteMessage: (id: string) =>
    request<{ deleted: boolean; state: string }>(
      `/messages/${encodeURIComponent(id)}`,
      mutation(undefined, "DELETE"),
    ),

  /** What may be sent, and how much is left today. */
  outboxCapabilities: () => request<OutboxCapabilities>("/outbox/capabilities"),
  /** Who this mailbox has actually corresponded with, for completing an address. */
  recipients: (q: string) => request<{ items: RecipientSuggestion[] }>(`/recipients${qs({ q })}`),
  compose: (input: ComposeInput, key: string) =>
    request<SendOutcome>("/outbox", sendingMutation(input, key)),
  /** Mark everything the current list would show as unread, read (C5). */
  markAllRead: (query: { filter?: string; domainId?: string; q?: string }) =>
    request<{ changed: number }>(
      `/messages/read-all?${new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][])}`,
      mutation(),
    ),

  /** A send that waits its turn (B6): the whole request sleeps in the vault; undo cancels. */
  scheduleSend: (kind: "compose" | "reply", input: Record<string, unknown>, delaySeconds: number) =>
    request<{ id: string; sendAt: string }>("/outbox/schedule", mutation({ kind, input, delaySeconds })),
  scheduledList: () => request<{ items: ScheduledSend[] }>("/scheduled"),
  cancelScheduled: (id: string) =>
    request<{ cancelled: boolean }>(`/scheduled/${encodeURIComponent(id)}/cancel`, mutation()),

  /** Quiet hours (D2): stored as minutes-from-local-midnight plus the owner's offset. */
  getQuietHours: () =>
    request<{ quietHours: { startMin: number; endMin: number; tzOffsetMin: number } | null }>(
      "/notifications/quiet-hours",
    ),
  setQuietHours: (input: { startMin: number; endMin: number; tzOffsetMin: number }) =>
    request<{ quietHours: typeof input }>("/notifications/quiet-hours", mutation(input)),
  clearQuietHours: () =>
    request<{ quietHours: null }>("/notifications/quiet-hours", mutation(undefined, "DELETE")),

  /** Read a message in another language (C11): made on demand, never stored. */
  translateMessage: (id: string, to: "vi" | "en") =>
    request<{ to: string; text: string }>(`/messages/${encodeURIComponent(id)}/translate`, mutation({ to })),

  /** The owner's kept addresses (B10). */
  listContacts: (q?: string) =>
    request<{ items: Contact[] }>(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  saveContact: (input: { address: string; name?: string | null; note?: string | null }) =>
    request<Contact>("/contacts", mutation(input)),
  deleteContact: (id: string) =>
    request<{ removed: boolean }>(`/contacts/${encodeURIComponent(id)}`, mutation(undefined, "DELETE")),

  /** The compose-in-progress, kept in the vault (B4) so it follows the owner's devices. */
  getDraft: (id: string) =>
    request<{ draft: Draft | null }>(`/drafts/${encodeURIComponent(id)}`),
  saveDraft: (id: string, input: Omit<Draft, "id" | "createdAt" | "updatedAt">) =>
    request<Draft>(`/drafts/${encodeURIComponent(id)}`, mutation(input, "PUT")),
  deleteDraft: (id: string) =>
    request<{ deleted: boolean }>(`/drafts/${encodeURIComponent(id)}`, mutation(undefined, "DELETE")),

  /** Devices holding a push subscription (D4). The endpoint is never part of these. */
  pushDevices: () => request<{ items: PushDevice[] }>("/push/devices"),
  labelPushDevice: (id: string, label: string) =>
    request<{ id: string; label: string }>(`/push/devices/${encodeURIComponent(id)}`, mutation({ label }, "PATCH")),
  revokePushDevice: (id: string) =>
    request<{ removed: boolean }>(`/push/devices/${encodeURIComponent(id)}`, mutation(undefined, "DELETE")),

  /** Which mail may interrupt (D1). Muting never touches storage or search. */
  listNotificationPrefs: () =>
    request<{ items: NotificationPref[] }>("/notifications/prefs"),
  setNotificationPref: (input: {
    scopeType: "alias" | "sender_domain";
    scopeValue: string;
    action: "all" | "mute";
  }) => request<NotificationPref>("/notifications/prefs", mutation(input)),
  deleteNotificationPref: (id: string) =>
    request<{ id: string }>(`/notifications/prefs/${encodeURIComponent(id)}`, mutation(undefined, "DELETE")),

  /** Hand one stored message to somebody new: an intro plus the original (B2). */
  forwardMessage: (id: string, input: ForwardInput, key: string) =>
    request<SendOutcome>(`/messages/${encodeURIComponent(id)}/forward`, sendingMutation(input, key)),

  /** A failed send, tried again as a new message in the same thread (B5). */
  resendMessage: (id: string) =>
    request<SendOutcome>(`/messages/${encodeURIComponent(id)}/resend`, mutation()),

  reply: (id: string, input: ReplyInput, key: string) =>
    request<SendOutcome>(`/messages/${encodeURIComponent(id)}/reply`, sendingMutation(input, key)),

  sendingPreview: (zoneId: string) =>
    request<SendingPreview>(`/domains/${encodeURIComponent(zoneId)}/sending`),
  refreshSending: () =>
    request<{ items: { domain: string; via: string; status: string; error?: string }[] }>(
      "/sending/refresh",
      mutation(),
    ),
  /** Every Email Sending name inside this zone, enabled or not. */
  sendingNames: (zoneId: string) =>
    request<{ items: { name: string; enabled: boolean; tag: string | null }[] }>(
      `/domains/${encodeURIComponent(zoneId)}/sending/names`,
    ),
  /** Which name this domain's mail leaves under. `null` puts it back to the domain itself. */
  setSendingVia: (zoneId: string, name: string | null) =>
    request<{ domainId: string; sendingVia: string | null; sendingStatus: string }>(
      `/domains/${encodeURIComponent(zoneId)}/sending-via`,
      mutation({ name }, "PUT"),
    ),
  enableSending: (zoneId: string, allowDmarcTakeover: boolean) =>
    request<{ domainId: string; sendingStatus: string; alreadyEnabled: boolean }>(
      `/domains/${encodeURIComponent(zoneId)}/sending`,
      mutation({ allowDmarcTakeover }),
    ),

  pushPublicKey: () => request<{ key: string | null }>("/push/public-key"),
  pushStatus: () => request<{ enabled: boolean; subscriptions: number }>("/push/status"),
  pushSubscribe: (input: { endpoint: string; p256dh: string; auth: string; userAgent?: string }) =>
    request<{ id: string }>("/push/subscribe", mutation(input)),
  pushUnsubscribe: (endpoint: string) =>
    request<{ removed: number }>("/push/unsubscribe", mutation({ endpoint })),
  pushTest: () => request<PushOutcome>("/push/test", mutation()),

  securityStatus: () => request<SecurityStatus>("/security/status"),
  passkeyOptions: () => request<PasskeyOptions>("/security/passkeys/options", mutation()),
  passkeyVerify: (input: { response: unknown; challenge: string; deviceLabel?: string }) =>
    request<{ passkey: Passkey }>("/security/passkeys/verify", mutation(input)),
  deletePasskey: (id: string) =>
    request<{ removed: boolean }>(
      `/security/passkeys/${encodeURIComponent(id)}`,
      mutation(undefined, "DELETE"),
    ),
  stepUpOptions: () => request<StepUpOptions>("/security/step-up/options", mutation()),
  stepUpVerify: (input: { response: unknown; challenge: string }) =>
    request<{ token: string; expiresAt: string; seconds: number }>(
      "/security/step-up/verify",
      mutation(input),
    ),

  listRules: () => request<{ items: Rule[] }>("/rules"),
  createRule: (input: { match: RuleMatch; action: RuleAction; enabled?: boolean }) =>
    request<Rule>("/rules", mutation(input)),
  updateRule: (id: string, patch: { match?: RuleMatch; action?: RuleAction; enabled?: boolean }) =>
    request<Rule>(`/rules/${encodeURIComponent(id)}`, mutation(patch, "PATCH")),
  deleteRule: (id: string) =>
    request<{ removed: boolean }>(
      `/rules/${encodeURIComponent(id)}`,
      mutation(undefined, "DELETE"),
    ),
  addressReuse: () => request<{ items: AddressReuse[] }>("/report/address-reuse"),

  semanticStatus: () => request<SemanticStatus>("/semantic"),
  semanticSet: (enabled: boolean) =>
    request<{ enabled: boolean; indexed: number; total: number; purged: number }>(
      "/semantic",
      mutation({ enabled }),
    ),
  semanticBackfill: () =>
    request<{ indexed: number; remaining: number }>("/semantic/backfill", mutation()),
};

/** What the server says about its own ability to send, and today's budget. */
export interface OutboxCapabilities {
  canCompose: boolean;
  bindingMissing: boolean;
  limit: number;
  sent: number;
  remaining: number;
  maxRecipients: number;
  domains: {
    domainId: string;
    name: string;
    mailStatus: string;
    sendingStatus: string;
    sendingVia: string | null;
    canSend: boolean;
  }[];
}

export interface SemanticStatus {
  enabled: boolean;
  indexed: number;
  total: number;
  model: string;
  dimensions: number;
  available: boolean;
}

/** Authenticated, same-origin download URL for an attachment (never a public URL). */
export function attachmentHref(messageId: string, attachmentId: string): string {
  return `${BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** The original .eml as it arrived — same authenticated download path as attachments. */
export function rawMessageHref(id: string): string {
  return `${BASE}/messages/${encodeURIComponent(id)}/raw`;
}

/** The address book as a file; a navigation, not a fetch, so the browser saves it. */
export const ALIASES_EXPORT_HREF = `${BASE}/aliases/export`;
