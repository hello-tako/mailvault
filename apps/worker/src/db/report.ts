import { visibleMessageSql } from "./visibility";
import type { AddressReuse } from "@mailvault/shared";

interface ReuseRow {
  sender_domain: string;
  aliases: number;
  messages: number;
  first_seen: string;
  last_seen: string;
}

/**
 * Which senders hold more than one of the owner's addresses.
 *
 * Matched on the SMTP envelope sender, because that is the address the mail actually came
 * from — a `From:` header can claim anything, and a report about where an address leaked
 * uses an observed envelope, not a verified sender identity.
 */
export async function addressReuseReport(db: D1Database): Promise<AddressReuse[]> {
  const { results } = await db
    .prepare(
      `SELECT lower(substr(m.envelope_from, instr(m.envelope_from, '@') + 1)) AS sender_domain,
              COUNT(DISTINCT m.alias_id) AS aliases,
              COUNT(*) AS messages,
              MIN(m.received_at) AS first_seen,
              MAX(m.received_at) AS last_seen
       FROM messages m
       WHERE ${visibleMessageSql()} AND m.envelope_from IS NOT NULL AND m.envelope_from LIKE '%@%' AND m.alias_id IS NOT NULL
       GROUP BY sender_domain
       HAVING aliases > 1
       ORDER BY aliases DESC, messages DESC`,
    )
    .all<ReuseRow>();

  return (results ?? [])
    .filter((r) => r.sender_domain.length > 0)
    .map((r) => ({
      senderDomain: r.sender_domain,
      aliases: Number(r.aliases),
      messages: Number(r.messages),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    }));
}
