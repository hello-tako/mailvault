-- Inbound arrival time is receiver-controlled; the sender's Date is separate metadata.
ALTER TABLE messages ADD COLUMN header_date TEXT;

-- NULL is an in-progress/new row. Existing messages predate lifecycle tracking and are
-- already durable; new inbound rows advance only after each idempotent stage succeeds.
ALTER TABLE messages ADD COLUMN ingest_status TEXT
  CHECK (ingest_status IN ('RULES_PENDING', 'SEMANTIC_PENDING', 'COMMITTED'));

-- Historical received_at values came from the sender's Date header. Preserve those
-- values as metadata and use the database creation time as an approximate receipt time.
UPDATE messages
SET header_date = received_at,
    received_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
WHERE direction = 'IN';

UPDATE messages SET ingest_status = 'COMMITTED';
