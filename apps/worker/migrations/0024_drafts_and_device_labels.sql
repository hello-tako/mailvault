-- 0024 — drafts that follow the owner between devices (plan B4), and device labels (D4).
--
-- A draft is the compose-in-progress: the fields as typed, keyed by the composer's slot —
-- "compose" for a new message, "reply-<message id>" for an answer — so every device the
-- owner signs in from picks up the same unfinished words. Attachments are deliberately not
-- drafted: they are bytes, and a half-written message's files are the vault's to keep only
-- once it is sent. Nothing here is mail yet: a draft never leaves the vault, and deleting
-- one is the only row that goes.

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  from_address TEXT,
  to_text TEXT,
  cc_text TEXT,
  bcc_text TEXT,
  subject TEXT,
  text TEXT,
  reply_to_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_updated_idx ON drafts (updated_at DESC);

-- A push subscription a lost phone still holds is a credential the owner cannot see; a
-- label is how the list of devices becomes a list the owner can actually read (D4).
ALTER TABLE push_subscriptions ADD COLUMN label TEXT;
