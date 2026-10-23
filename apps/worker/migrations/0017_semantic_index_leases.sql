-- A semantic upsert can outlive the D1 snapshot used by a deletion request. Keep a
-- renewable writer marker so cleanup can wait for an in-flight Vectorize write.
CREATE TABLE semantic_index_leases (
  message_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  lease_until TEXT NOT NULL
);

CREATE INDEX idx_semantic_index_leases_expiry ON semantic_index_leases(lease_until);
