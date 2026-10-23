-- Persist deterministic R2 keys before a send starts writing them. The lease fences
-- deletion against a live sender; uncertainty is sticky after an expired in-flight put.
CREATE TABLE outbound_staging (
  message_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  alias_id TEXT NOT NULL,
  r2_keys_json TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  writes_started INTEGER NOT NULL DEFAULT 0 CHECK (writes_started IN (0, 1)),
  writes_settled INTEGER NOT NULL DEFAULT 1 CHECK (writes_settled IN (0, 1)),
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1))
);

CREATE INDEX idx_outbound_staging_alias ON outbound_staging(alias_id);

-- Alias purge can race the first message insert. This also protects the window after the
-- sender has been fenced but before its unlinked staging manifest is tombstoned.
CREATE TRIGGER prevent_outbound_message_after_alias_purge
BEFORE INSERT ON messages
WHEN NEW.direction = 'OUT' AND NEW.alias_id IS NOT NULL AND (
  NOT EXISTS (SELECT 1 FROM aliases WHERE id = NEW.alias_id AND status = 'ACTIVE')
  OR EXISTS (
    SELECT 1 FROM deletion_jobs
    WHERE job_type = 'ALIAS_PURGE' AND alias_id = NEW.alias_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'outbound_alias_purged');
END;
