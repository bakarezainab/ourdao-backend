-- compat: backward-compatible
-- Issue #608: GET /admin/audit-log pages and sorts exclusively by `id`
-- (`?before=` is `id < $N`, `ORDER BY id DESC`), never `created_at` -- but
-- the two composite indexes built for its `?admin=`/`?action=` filters are
-- keyed `(admin_address, created_at DESC)` / `(action, created_at DESC)`,
-- so neither one's trailing column matches the column the query actually
-- sorts and pages by.
--
-- EXPLAIN ANALYZE at 305k seeded rows (docs/admin-audit-log-query-plan.md)
-- found the planner never chooses either `created_at`-keyed composite index
-- for this query shape in the first place -- it already prefers a backward
-- scan of the primary key with `admin_address`/`action` applied as a heap
-- filter, which is fast while a filtered admin/action's rows are clustered
-- near the recent end of the log. That assumption breaks for an admin or
-- action with little *recent* activity (e.g. an operator who rotated out):
-- the backward pkey scan then has to skip the entire log to find a page's
-- worth of matches (~210ms at 305k rows in the measurement), where an
-- `id`-keyed index serves the same query directly off its own entries
-- (~0.4ms). Replacing the composite indexes with `id`-keyed equivalents
-- costs nothing on the common path and removes that tail latency when the
-- planner does pick them.
DROP INDEX IF EXISTS admin_audit_log_admin_address_idx;
DROP INDEX IF EXISTS admin_audit_log_action_idx;

CREATE INDEX IF NOT EXISTS admin_audit_log_admin_address_id_idx ON admin_audit_log (admin_address, id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_action_id_idx ON admin_audit_log (action, id DESC);
