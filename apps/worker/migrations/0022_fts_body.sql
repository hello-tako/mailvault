-- 0022 — the search index grows a body column (audit T1 / plan C1).
--
-- The vault exists to find an old OTP, invoice or sentence again; until now keyword search
-- only read subject, preview and sender, and a word that lived past the 280-character
-- preview was findable only through the opt-in semantic index. The body text joins the same
-- FTS5 table — still inside D1, the same trust boundary the preview already lives in —
-- capped at 20,000 characters per message.
--
-- fts5 cannot grow a column, so the table is rebuilt from the columns the messages table
-- already holds. Bodies of mail already stored arrive afterwards, in hourly batches, from
-- each message's parsed copy in R2 (src/mail/fts-backfill.ts, driven by the cron).

DROP TABLE messages_fts;
CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED,
  subject,
  preview,
  sender,
  body
);
INSERT INTO messages_fts (message_id, subject, preview, sender)
SELECT id, COALESCE(subject, ''), COALESCE(preview, ''), COALESCE(header_from, '')
FROM messages
WHERE deletion_pending = 0;
