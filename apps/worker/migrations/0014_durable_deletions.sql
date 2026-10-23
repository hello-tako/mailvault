-- Persist the owner's delete request before cleaning external stores. Mail remains in D1
-- while its R2 and optional Vectorize copies are retried, but list/detail queries hide it.
ALTER TABLE messages ADD COLUMN deletion_pending INTEGER NOT NULL DEFAULT 0
  CHECK (deletion_pending IN (0, 1));

-- These rows intentionally have no message/alias FK: they survive final metadata deletion
-- to report completion and make repeated DELETE requests idempotent.
CREATE TABLE deletion_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('MESSAGE', 'ALIAS_PURGE')),
  message_id TEXT UNIQUE,
  dedupe_key TEXT,
  alias_id TEXT,
  r2_keys_json TEXT NOT NULL DEFAULT '[]',
  vector_id TEXT,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (job_type = 'MESSAGE' AND message_id IS NOT NULL AND dedupe_key IS NOT NULL AND alias_id IS NULL) OR
    (job_type = 'ALIAS_PURGE' AND message_id IS NULL AND alias_id IS NOT NULL)
  )
);

CREATE INDEX idx_deletion_jobs_due ON deletion_jobs(state, next_attempt_at, lease_until);
CREATE INDEX idx_deletion_jobs_alias ON deletion_jobs(alias_id, state) WHERE job_type = 'ALIAS_PURGE';
CREATE UNIQUE INDEX idx_deletion_jobs_alias_purge ON deletion_jobs(alias_id) WHERE job_type = 'ALIAS_PURGE';
CREATE UNIQUE INDEX idx_deletion_jobs_message_dedupe ON deletion_jobs(dedupe_key)
  WHERE job_type = 'MESSAGE' AND dedupe_key IS NOT NULL;

-- A completed deletion job is a durable identity tombstone. Queue retries may arrive
-- after the message and its staged R2 objects have been permanently removed.
CREATE TRIGGER prevent_deleted_message_resurrection
BEFORE INSERT ON messages
WHEN EXISTS (
  SELECT 1 FROM deletion_jobs
  WHERE job_type = 'MESSAGE' AND (message_id = NEW.id OR dedupe_key = NEW.dedupe_key)
)
BEGIN
  SELECT RAISE(ABORT, 'message_deletion_tombstoned');
END;

-- Route-level counts are useful errors, but this invariant closes the race before the
-- domain's cascading FKs can erase any mail or aliases.
CREATE TRIGGER prevent_domain_delete_with_mail
BEFORE DELETE ON domains
WHEN EXISTS (SELECT 1 FROM messages WHERE domain_id = OLD.id)
  OR EXISTS (SELECT 1 FROM aliases WHERE domain_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'domain_has_dependents');
END;
