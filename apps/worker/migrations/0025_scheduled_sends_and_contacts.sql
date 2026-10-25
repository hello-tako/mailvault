-- 0025 — sends that wait their turn (B6), and the owner's own address book (B10).
--
-- A scheduled send keeps the whole compose request in D1 and lets a queue message — delayed
-- by exactly the wait — call it back. The queue carries only the row's id (a queue is never
-- a second home for message content); the row is the truth, which is also what makes undo
-- possible: cancelling is a row update, and a consumer that finds anything other than
-- WAITING simply acks and walks away.

CREATE TABLE IF NOT EXISTS scheduled_sends (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('compose', 'reply')),
  payload_json TEXT NOT NULL,
  send_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'WAITING' CHECK (state IN ('WAITING', 'SENT', 'CANCELLED', 'FAILED')),
  message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_sends_due_idx ON scheduled_sends (state, send_at);

-- Contacts are addresses the owner chose to keep, not everyone who ever wrote in (B10).
-- Autocomplete offers them first; correspondence history stays what it always was.
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  name TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
