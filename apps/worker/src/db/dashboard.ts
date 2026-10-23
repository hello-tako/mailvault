import { visibleMessageSql } from "./visibility";
import type { DashboardStats, MailboxStat } from "@mailvault/shared";
import { MailStatus } from "@mailvault/shared";
import { toMessageSummary } from "./mappers";
import type { MessageRow } from "./rows";

/**
 * Every domain as a mailbox, busiest first. Domains with no mail are included rather
 * than filtered out: the owner needs to see that a domain is *empty*, which is a
 * different fact from it not existing.
 */
const MAILBOX_SQL = `
  SELECT
    d.id AS domain_id,
    d.name AS name,
    d.mail_status AS mail_status,
    COUNT(m.id) AS total,
    COALESCE(SUM(CASE WHEN m.is_read = 0 AND m.archived = 0 THEN 1 ELSE 0 END), 0) AS unread,
    MAX(m.received_at) AS last_received_at
  FROM domains d
  LEFT JOIN messages m ON m.domain_id = d.id AND ${visibleMessageSql()}
  GROUP BY d.id, d.name, d.mail_status
  ORDER BY unread DESC, total DESC, d.name ASC
`;

interface MailboxRow {
  domain_id: string;
  name: string;
  mail_status: string;
  total: number;
  unread: number;
  last_received_at: string | null;
}

function toMailbox(r: MailboxRow): MailboxStat {
  return {
    domainId: r.domain_id,
    name: r.name,
    mailStatus: r.mail_status as MailboxStat["mailStatus"],
    total: Number(r.total ?? 0),
    unread: Number(r.unread ?? 0),
    lastReceivedAt: r.last_received_at ?? null,
  };
}

export async function getDashboardStats(db: D1Database, recentLimit = 8): Promise<DashboardStats> {
  const [domains, aliases, messages, unread, recent, mailboxes] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN mail_status = ?1 THEN 1 ELSE 0 END) AS ready
         FROM domains`,
      )
      .bind(MailStatus.Ready)
      .first<{ total: number; ready: number }>(),
    db.prepare(`SELECT COUNT(*) AS c FROM aliases`).first<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) AS c FROM messages m WHERE ${visibleMessageSql()}`).first<{ c: number }>(),
    // Archived mail is filed, not gone, but it is out of the working list — so it does not
    // count towards the unread badge or the mailbox cards either.
    db.prepare(`SELECT COUNT(*) AS c FROM messages m WHERE ${visibleMessageSql()} AND is_read = 0 AND archived = 0`).first<{ c: number }>(),
    db
      .prepare(
        `SELECT m.*, a.label AS alias_label, a.address AS alias_address, d.name AS domain_name
         FROM messages m
         LEFT JOIN aliases a ON a.id = m.alias_id
         LEFT JOIN domains d ON d.id = m.domain_id
         WHERE m.archived = 0 AND ${visibleMessageSql()}
         ORDER BY m.received_at DESC, m.id DESC LIMIT ?1`,
      )
      .bind(recentLimit)
      .all<MessageRow>(),
    db.prepare(MAILBOX_SQL).all<MailboxRow>(),
  ]);

  return {
    activeDomains: Number(domains?.ready ?? 0),
    totalDomains: Number(domains?.total ?? 0),
    totalAliases: Number(aliases?.c ?? 0),
    unreadMessages: Number(unread?.c ?? 0),
    totalMessages: Number(messages?.c ?? 0),
    recentMessages: (recent.results ?? []).map(toMessageSummary),
    mailboxes: (mailboxes.results ?? []).map(toMailbox),
  };
}
