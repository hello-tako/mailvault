-- Persist every inbound object key before the first R2 write. Rows are retained
-- after deletion so a later sweep can repair an object write that completed late.
CREATE TABLE inbound_staging (
  message_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'WRITING'
    CHECK (state IN ('WRITING', 'STAGED', 'COMMITTED', 'TOMBSTONED')),
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  writes_settled INTEGER NOT NULL DEFAULT 0 CHECK (writes_settled IN (0, 1)),
  cleanup_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_confirmed IN (0, 1)),
  next_sweep_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_inbound_staging_dedupe ON inbound_staging(dedupe_key);
CREATE INDEX idx_inbound_staging_alias ON inbound_staging(alias_id);
CREATE INDEX idx_inbound_staging_reconcile ON inbound_staging(state, next_sweep_at, lease_expires_at);

CREATE TABLE inbound_staging_objects (
  message_id TEXT NOT NULL REFERENCES inbound_staging(message_id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  PRIMARY KEY (message_id, r2_key)
);

CREATE INDEX idx_inbound_staging_objects_key ON inbound_staging_objects(r2_key);

-- Deletion becomes a durable write fence in the same D1 transaction as its tombstone.
CREATE TRIGGER fence_inbound_staging_on_message_delete
AFTER INSERT ON deletion_jobs
WHEN NEW.job_type IN ('MESSAGE', 'ALIAS_PURGE')
BEGIN
  UPDATE inbound_staging SET state = 'TOMBSTONED', updated_at = NEW.updated_at
  WHERE (NEW.job_type = 'MESSAGE' AND (message_id = NEW.message_id OR dedupe_key = NEW.dedupe_key))
     OR (NEW.job_type = 'ALIAS_PURGE' AND alias_id = NEW.alias_id);
END;

-- Fence the gap between the consumer's check and its metadata INSERT.
CREATE TRIGGER prevent_purged_alias_message_resurrection
BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE' AND alias_id = NEW.alias_id)
BEGIN
  SELECT RAISE(ABORT, 'alias_purge_tombstoned');
END;
