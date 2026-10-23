import type {
  AliasStatus,
  AuthPolicy,
  AuthVerdict,
  CatchAllStatus,
  ConflictType,
  MailStatus,
  MessageDirection,
  RoutingStatus,
  SendingStatus,
} from "@mailvault/shared";

/** Raw D1 row shapes (snake_case, TEXT/INTEGER). Mappers convert these to DTOs. */

export interface DomainRow {
  id: string;
  cloudflare_zone_id: string;
  cloudflare_account_id: string | null;
  name: string;
  zone_status: string;
  zone_type: string;
  mail_status: MailStatus;
  routing_status: RoutingStatus;
  catch_all_status: CatchAllStatus;
  conflict_type: ConflictType;
  conflict_details_json: string | null;
  auth_policy: AuthPolicy;
  sending_status: SendingStatus;
  sending_via: string | null;
  sending_tag: string | null;
  sending_checked_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AliasRow {
  id: string;
  domain_id: string;
  local_part: string;
  address: string;
  label: string | null;
  notes: string | null;
  pinned: number;
  archived: number;
  status: AliasStatus;
  created_at: string;
  updated_at: string;
  domain_name?: string;
  message_count?: number;
  unread_count?: number;
}

export interface MessageRow {
  id: string;
  domain_id: string;
  alias_id: string;
  provider_message_id: string | null;
  dedupe_key: string;
  envelope_from: string | null;
  envelope_to: string | null;
  header_from: string | null;
  header_to: string | null;
  subject: string | null;
  preview: string | null;
  received_at: string;
  header_date?: string | null;
  raw_size: number;
  raw_r2_key: string;
  parsed_r2_key: string | null;
  has_attachments: number;
  attachment_count: number;
  is_read: number;
  starred: number;
  archived: number;
  rule_tag: string | null;
  applied_rule_id: string | null;
  applied_rule_note: string | null;
  extracted_codes_json: string | null;
  verification_links_json: string | null;
  auth_verdict: AuthVerdict;
  auth_json: string | null;
  direction: MessageDirection;
  thread_root_id: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  reply_to: string | null;
  cc: string | null;
  send_status: string | null;
  send_error: string | null;
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
  created_at: string;
  // Joined context columns
  alias_label?: string | null;
  alias_address?: string | null;
  domain_name?: string | null;
  /** bm25 relevance from the search query; absent on unfiltered listing. */
  rank?: number | null;
}

/** One destination of a sent message, as Email Sending reported it. */
export interface MessageRecipientRow {
  id: string;
  message_id: string;
  address: string;
  list: "to" | "cc" | "bcc";
  status: string;
  rank: number;
  smtp_code: string | null;
  detail: string | null;
  updated_at: string;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  safe_filename: string;
  content_type: string | null;
  size: number;
  r2_key: string;
  content_id: string | null;
  created_at: string;
}
