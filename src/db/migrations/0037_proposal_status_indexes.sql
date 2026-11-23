-- compat: backward-compatible
-- Issue #605 — GET /api/proposals/loan and GET /api/proposals/treasury both
-- filter on ?status= the same way GET /api/loans does, but loan_proposals
-- and treasury_proposals had no index on status (unlike loans_status_idx).
-- EXPLAIN ANALYZE at 300k rows (docs/proposal-status-query-plan.md) found
-- the existing `ORDER BY id DESC LIMIT n` already serves a recent-skewed
-- status cheaply via a backward primary-key scan, but a realistic small
-- backlog of long-stuck proposals (status matches scattered only among old
-- ids, e.g. a handful of proposals nobody ever voted on) forces a full
-- parallel sequential scan without this index — 90ms+ at this scale, down to
-- under 1ms with it, for about 4% of the table's size in index storage.
CREATE INDEX IF NOT EXISTS loan_proposals_status_idx ON loan_proposals (status);
CREATE INDEX IF NOT EXISTS treasury_proposals_status_idx ON treasury_proposals (status);
