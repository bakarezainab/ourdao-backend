# Query plan: `GET /api/members`

Recorded for issue #607. `members_active_idx` is a partial index on
`(address) WHERE exited = false`, added for `/api/stats`' active-member
`count(*)` (issue #18). It has no `joined_ledger` column, so it cannot serve
`GET /api/members`' sort (`ORDER BY joined_ledger DESC NULLS LAST`) at all --
the route's own comment already calls this out as "the closest thing this
codebase has to a leaderboard" and names the cost as "full table scan +
sort".

## Setup

- Postgres 16 (the project's `docker-compose.yml` image), `src/db/schema.sql`
  applied to an empty database, before the migration below.
- `members` seeded to 200,000 rows: 90% carry a `joined_ledger` (the rest are
  phantom `name_reg`/`staked`-only rows per the route's own filter comment),
  and 85% of real members are still active (`exited = false`) -- about
  154,000 rows match the route's `WHERE` clause, a plausible near-term scale.
- The query is exactly the route's SQL with `LIMIT 50`, run after
  `VACUUM ANALYZE`.
- The seeding script is not committed; the shape above is what matters and
  is easy to reproduce.

## Before: no supporting index

```
Limit  (cost=10591.57..10591.69 rows=50 width=164) (actual time=173.155..173.177 rows=50 loops=1)
  Buffers: shared hit=3400
  ->  Sort  (cost=10591.57..10982.50 rows=156372 width=164) (actual time=173.153..173.163 rows=50 loops=1)
        Sort Key: joined_ledger DESC NULLS LAST
        Sort Method: top-N heapsort  Memory: 38kB
        Buffers: shared hit=3400
        ->  Seq Scan on members  (cost=0.00..5397.00 rows=156372 width=164) (actual time=0.031..81.558 rows=154000 loops=1)
              Filter: ((NOT exited) AND (joined_ledger IS NOT NULL))
              Rows Removed by Filter: 46000
              Buffers: shared hit=3397
Planning Time: 5.410 ms
Execution Time: 173.371 ms
```

(With `max_parallel_workers_per_gather` at its default, Postgres parallelizes
this seq scan across two workers and lands around 147ms instead -- still a
full scan and sort of every active member, just split up.)

## Candidate index: `(joined_ledger DESC NULLS LAST) WHERE exited = false AND joined_ledger IS NOT NULL`

A first attempt spelled the index as `(joined_ledger DESC)` (no explicit
null-ordering) and the planner **ignored it outright**, at every scale
tested, still choosing Seq Scan + Sort. The reason: a `DESC` btree defaults
its null-ordering metadata to `NULLS FIRST` regardless of what the partial
predicate excludes, so the index's declared output order
(`joined_ledger DESC NULLS FIRST`) doesn't match the query's requested
pathkey (`joined_ledger DESC NULLS LAST`) -- the planner won't use an index
whose sort order it can't prove matches, even though every row the index
contains already excludes nulls. Spelling the index with an explicit
`NULLS LAST` fixes this:

```
Limit  (cost=0.42..2.56 rows=50 width=164) (actual time=0.134..0.193 rows=50 loops=1)
  Buffers: shared hit=2 read=3
  ->  Index Scan using members_active_joined_ledger_idx on members  (cost=0.42..6712.39 rows=156983 width=164) (actual time=0.131..0.173 rows=50 loops=1)
        Buffers: shared hit=2 read=3
Planning Time: 2.915 ms
Execution Time: 0.419 ms
```

**~175ms -> ~0.4ms**, and buffers read drops from ~3400 (the whole active
set) to 5 (the 50 rows the route actually returns). The planner now walks the
index in exactly the order the route needs and stops at `LIMIT 50` instead of
reading and sorting every active member on every cache-miss request.

At a smaller, current-scale seed (5,000 members, ~3,850 matching) the same
index exists but the planner reasonably prefers the Seq Scan -- the table
fits in a handful of pages and a full scan is already sub-millisecond, so
there's nothing for an index to save. The win only shows up once the active
membership is large enough that "scan everything" stops being the cheap
option, which is exactly the growth curve this route is on.

## Is `members_active_idx` now redundant?

No. `/api/stats` (`src/api/routes/index.ts`) runs two aggregates with no
`joined_ledger` filter at all:

```sql
SELECT COALESCE(sum(stake), 0) FROM members WHERE exited = false
SELECT COALESCE(sum(contribution), 0) FROM members WHERE exited = false
```

`members_active_joined_ledger_idx`'s predicate (`exited = false AND
joined_ledger IS NOT NULL`) is strictly narrower than `members_active_idx`'s
(`exited = false`), so it cannot serve these two queries -- a member who is
active but has a null `joined_ledger` (shouldn't happen in practice, but the
schema doesn't forbid it) would be silently excluded from the sum. Both
indexes stay.

## Conclusion

`src/db/migrations/0034_members_active_joined_ledger_idx.sql` adds
`members_active_joined_ledger_idx`, and `src/db/schema.sql` is updated to
match.
