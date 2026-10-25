-- Payloads/MACs/codes are never persisted. Expired nonces are boundedly pruned on authenticated calls.
CREATE TABLE customer_otp_rpc_nonces (
  request_id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_customer_otp_rpc_nonces_expiry ON customer_otp_rpc_nonces(expires_at);
