-- 0023 — notification preferences (plan D1): which mail is allowed to interrupt.
--
-- Two scopes answer the two questions an owner actually asks: "stop telling me about this
-- address" (alias — a busy newsletter box kept for the archive) and "stop telling me about
-- this sender" (their whole domain). Storage and search are untouched: muted mail is kept
-- and indexed exactly like any other; only the ping, the toast and the socket nudge are
-- withheld. The default row state is the absence of a row — everything notifies.

CREATE TABLE IF NOT EXISTS notification_prefs (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('alias', 'sender_domain')),
  scope_value TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('all', 'mute')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_type, scope_value)
);
