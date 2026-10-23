import type {
  Alias,
  ConflictDetails,
  Domain,
  ExtractedCode,
  MessageAuth,
  MessageSummary,
  SendStatus,
  VerificationLink,
} from "@mailvault/shared";
import { MessageDirection } from "@mailvault/shared";
import type { AliasRow, DomainRow, MessageRow } from "./rows";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toDomain(row: DomainRow): Domain {
  return {
    id: row.id,
    cloudflareZoneId: row.cloudflare_zone_id,
    cloudflareAccountId: row.cloudflare_account_id,
    name: row.name,
    zoneStatus: row.zone_status,
    zoneType: row.zone_type,
    mailStatus: row.mail_status,
    routingStatus: row.routing_status,
    catchAllStatus: row.catch_all_status,
    conflictType: row.conflict_type,
    conflictDetails: parseJson<ConflictDetails | null>(row.conflict_details_json, null),
    authPolicy: row.auth_policy,
    sendingStatus: row.sending_status,
    sendingVia: row.sending_via ?? null,
    sendingTag: row.sending_tag ?? null,
    sendingCheckedAt: row.sending_checked_at ?? null,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toAlias(row: AliasRow): Alias {
  return {
    id: row.id,
    domainId: row.domain_id,
    domainName: row.domain_name,
    localPart: row.local_part,
    address: row.address,
    label: row.label,
    notes: row.notes ?? null,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    status: row.status,
    messageCount: row.message_count != null ? Number(row.message_count) : undefined,
    unreadCount: row.unread_count != null ? Number(row.unread_count) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function strongestCode(codes: ExtractedCode[]): ExtractedCode | null {
  if (codes.length === 0) return null;
  return codes.reduce(
    (best, c) => (c.confidence > best.confidence ? c : best),
    codes[0] as ExtractedCode,
  );
}

export function toMessageSummary(row: MessageRow): MessageSummary {
  const codes = parseJson<ExtractedCode[]>(row.extracted_codes_json, []);
  const links = parseJson<VerificationLink[]>(row.verification_links_json, []);
  const primary = strongestCode(codes);
  return {
    id: row.id,
    aliasId: row.alias_id,
    aliasAddress: row.alias_address ?? "",
    aliasLabel: row.alias_label ?? null,
    domainName: row.domain_name ?? "",
    envelopeFrom: row.envelope_from ?? "",
    headerFrom: row.header_from,
    headerTo: row.header_to,
    subject: row.subject,
    preview: row.preview,
    receivedAt: row.received_at,
    headerDate: row.header_date ?? null,
    isRead: row.is_read === 1,
    // Mail stored before the column existed reads as unstarred rather than undefined.
    starred: Number(row.starred ?? 0) === 1,
    archived: row.archived === 1,
    ruleTag: row.rule_tag ?? null,
    hasAttachments: row.has_attachments === 1,
    attachmentCount: Number(row.attachment_count),
    primaryCode: primary ? primary.value : null,
    codeCount: codes.length,
    linkCount: links.length,
    authVerdict: row.auth_verdict,
    direction: row.direction ?? MessageDirection.In,
    // Mail stored before threading existed is its own conversation. The fallback lives here
    // as well as in the migration, so a row can never report that it has no thread.
    threadRootId: row.thread_root_id ?? row.id,
    sendStatus: (row.send_status as SendStatus | null) ?? null,
    cc: row.cc ?? null,
  };
}

/** The stored assessment, or null for mail that predates authentication recording. */
export function toMessageAuth(row: Pick<MessageRow, "auth_json">): MessageAuth | null {
  const raw = parseJson<MessageAuth | null>(row.auth_json, null);
  return raw && typeof raw.verdict === "string" ? raw : null;
}

export { parseJson };
