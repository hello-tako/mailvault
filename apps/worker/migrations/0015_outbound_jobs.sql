-- Idempotency records outlive deleted messages so a stale client cannot resend them.
CREATE TABLE outbound_jobs (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('STAGING','DISPATCHING','ACCEPTED','FAILED','DELETED')),
  quota_charged INTEGER NOT NULL DEFAULT 0 CHECK(quota_charged IN (0,1)),
  provider_message_id TEXT,
  error_code TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX outbound_jobs_quota ON outbound_jobs(created_at, state);
