-- 0013: the customer code portal.
--
-- A grant is one unguessable link handed to one buyer for one alias. Only the SHA-256 of the
-- token is stored, so a database read cannot mint or enumerate links. Nothing here widens
-- access to message bodies: the portal answers with a code and a timestamp, or nothing.
CREATE TABLE IF NOT EXISTS portal_grants (
  id TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- A grant may be spent a fixed number of times; NULL keeps it open until it expires.
  max_views INTEGER,
  views INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS portal_grants_alias_idx ON portal_grants (alias_id, created_at DESC);
