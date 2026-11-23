-- compat: backward-compatible
-- Issue #607: GET /api/members' query (`WHERE exited = false AND
-- joined_ledger IS NOT NULL ORDER BY joined_ledger DESC NULLS LAST`) has no
-- index shaped for its sort order -- members_active_idx is keyed on
-- `address`, not `joined_ledger`. EXPLAIN ANALYZE at 200k seeded members
-- (docs/member-activity-query-plan.md's methodology) showed a Seq Scan +
-- Sort costing ~175ms; this index drops it to a direct Index Scan + Limit
-- at <1ms. Measurements are in docs/members-active-idx-query-plan.md.
--
-- NULLS LAST is spelled out explicitly even though the partial predicate
-- already excludes NULL `joined_ledger` rows: a DESC btree defaults its
-- null-ordering metadata to NULLS FIRST, and that default alone is enough
-- for the planner to decide the index's output order doesn't match
-- `ORDER BY joined_ledger DESC NULLS LAST` and fall back to a full sort.
CREATE INDEX IF NOT EXISTS members_active_joined_ledger_idx
  ON members (joined_ledger DESC NULLS LAST)
  WHERE exited = false AND joined_ledger IS NOT NULL;
