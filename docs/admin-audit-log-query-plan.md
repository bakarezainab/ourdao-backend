# Query plan: `GET /admin/audit-log`

Recorded for issue #608. `admin_audit_log` carries two composite indexes
built for this route's `?admin=`/`?action=` filters -- `(admin_address,
created_at DESC)` and `(action, created_at DESC)` -- but the route
(`src/api/routes/index.ts`) pages and sorts exclusively by `id` (`?before=`
is `id < $N`, `ORDER BY id DESC`), never `created_at`. Neither composite
index's trailing column matches the column actually being sorted/paged.

## Setup

- Postgres 16, `src/db/schema.sql` applied to an empty database, before the
  migration below.
- `admin_audit_log` seeded to 305,000 rows: 300,000 spread across 25 admin
  addresses and 8 action types (a skew modeling real operator activity --
  a handful of admins/actions dominate), plus a 26th admin
  (`GSTALEADMIN...`) given 5,000 rows **inserted first**, so its `id`s are
  the oldest in the table -- modeling an operator who stopped acting long
  ago and has no recent rows at all.
- The queries are exactly the route's SQL with `LIMIT 50`, run after
  `VACUUM ANALYZE`.
- The seeding script is not committed; the shape above is what matters and
  is easy to reproduce.

## Before: the created_at-keyed composite indexes are never chosen

Filtering by `admin_address` (same shape for `action`):

```
Limit  (cost=0.42..55.43 rows=50 width=107) (actual time=0.089..0.668 rows=50 loops=1)
  Buffers: shared hit=31
  ->  Index Scan Backward using admin_audit_log_pkey on admin_audit_log  (cost=0.42..13709.42 rows=12460 width=107) (actual time=0.087..0.657 rows=50 loops=1)
        Filter: (admin_address = 'G0000000000000000000000000000000000000000000000000000001'::text)
        Rows Removed by Filter: 1176
        Buffers: shared hit=31
Planning Time: 3.303 ms
Execution Time: 0.843 ms
```

Across every shape tried (recent/common admin, recent/common action), the
planner never picks `admin_audit_log_admin_address_idx` or
`admin_audit_log_action_idx` for this query. It prefers a backward scan of
the primary key with the filter applied as a heap check -- and for an admin
or action whose rows are reasonably close to the recent end of the log, this
is genuinely fast (under 1ms above): few rows get skipped before 50 matches
turn up. The created_at-keyed composite indexes are confirmed dead weight on
every write to this table for this specific query shape; nothing else in the
codebase queries `admin_audit_log` sorted by `created_at` (grep finds exactly
one read of this table: the route above, always `ORDER BY id DESC`).

## The failure mode: an admin/action with no recent activity

That backward-pkey-scan plan's speed depends on matches being close to the
recent end. `GSTALEADMIN`'s 5,000 rows are the *oldest* 5,000 ids in a
305,000-row table:

```
Limit  (cost=0.42..138.03 rows=50 width=106) (actual time=211.940..212.011 rows=50 loops=1)
  Buffers: shared hit=6967
  ->  Index Scan Backward using admin_audit_log_pkey on admin_audit_log  (cost=0.42..13934.92 rows=5063 width=106) (actual time=211.935..211.987 rows=50 loops=1)
        Filter: (admin_address = 'GSTALEADMIN00000000000000000000000000000000000000000000'::text)
        Rows Removed by Filter: 300000
        Buffers: shared hit=6967
Planning Time: 4.647 ms
Execution Time: 212.486 ms
```

**~212ms**, scanning (and discarding) all 300,000 newer rows before finding
this admin's 50 most recent actions.

## Candidate index: `(admin_address, id DESC)` / `(action, id DESC)`

With `admin_audit_log_pkey` temporarily dropped (forcing the comparison --
see below for why this is necessary), the same query against a candidate
`(admin_address, id DESC)` index:

```
Limit  (cost=0.42..137.77 rows=50 width=106) (actual time=0.145..0.205 rows=50 loops=1)
  Buffers: shared hit=1 read=3
  ->  Index Scan using admin_audit_log_admin_address_id_idx on admin_audit_log  (cost=0.42..14130.26 rows=5144 width=106) (actual time=0.143..0.167 rows=50 loops=1)
        Index Cond: (admin_address = 'GSTALEADMIN00000000000000000000000000000000000000000000'::text)
        Buffers: shared hit=1 read=3
Planning Time: 6.731 ms
Execution Time: 0.435 ms
```

**~212ms -> ~0.4ms** -- the index serves the query directly from its own
entries, in `id` order, independent of where those entries sit in the
overall table.

## A caveat worth recording: the planner doesn't always pick it

With **both** `admin_audit_log_pkey` and the new `admin_audit_log_admin_address_id_idx`
present (the real post-migration state, not the pkey-dropped comparison
above), Postgres's own cost estimates for the two plans are nearly tied
(138.03 vs. 137.77 cost units in these measurements) -- and in this
measurement it kept choosing the pkey-backward-scan plan, reproducing the
full ~212ms cost, even with the better index sitting right there. The
planner's selectivity model assumes a filter value's matching rows are
spread uniformly through the table; it has no way to know `GSTALEADMIN`'s
rows are all clustered at one end, so it can't see that the pkey plan's
*actual* cost is three orders of magnitude worse than its estimate. This is
a known class of Postgres planner limitation (a filter uncorrelated with the
sort/scan order), not something an index shape alone can force a fix for.

This doesn't make the new index pointless: it's correct, cheap on writes
relative to what it replaces, and the planner does take it when the pkey
path isn't an option (verified by dropping `admin_audit_log_pkey` inside a
rolled-back transaction, as above) or when it's clearly cheaper by a wider
margin than the near-tie case here. Forcing the planner to prefer it in
every case (e.g. via extended statistics or a query hint) is outside this
issue's scope -- recorded here as the situation to revisit if admin/action
tail latency on this route ever shows up in practice.

## Conclusion

`src/db/migrations/0036_admin_audit_log_id_keyed_indexes.sql` drops
`admin_audit_log_admin_address_idx` / `admin_audit_log_action_idx` and
replaces them with `admin_audit_log_admin_address_id_idx` / `admin_audit_log_action_id_idx`.
`admin_audit_log_created_at_idx` (the plain, non-composite index) is
untouched -- out of this issue's scope, and not used by the route either,
but that's a separate finding.
