-- 0014 — indexes for the two queries that run on every mailbox screen.
--
-- The working list asks one question above all others: received (or sent), unfiled,
-- newest first. `direction` and `archived` lead so every tab/filter combination seeks
-- straight to its rows and walks them already ordered — before this, the default inbox
-- view was a full scan plus a sort, which is fine at hundreds of messages and quietly
-- expensive at tens of thousands.
CREATE INDEX IF NOT EXISTS idx_messages_working_list
  ON messages (direction, archived, received_at DESC, id DESC);

-- The counters endpoint aggregates direction/archived/is_read and groups unread by
-- domain. This index carries exactly those columns, so both statements in
-- `messageCounters` become index-only scans: the whole table no longer has to be read
-- to say "3 unread".
CREATE INDEX IF NOT EXISTS idx_messages_counter_cover
  ON messages (domain_id, direction, archived, is_read);
