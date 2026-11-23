# Query plan: `GET /api/proposals/loan?status=` and `GET /api/proposals/treasury?status=`

Recorded for issue #605: `loans` has `loans_status_idx` to support `GET
/api/loans?status=`, but `loan_proposals` and `treasury_proposals` had no
index on `status` even though both proposal endpoints filter on it the same
way. The question was whether that gap actually costs anything, same
methodology as `docs/member-activity-query-plan.md`.

## Setup

- Postgres 16 (Docker, default configuration), `src/db/schema.sql` applied to
  an empty database.
- `loan_proposals` and `treasury_proposals` seeded with 300 000 rows each,
  `id` 1..300000, distributed over the same handful of statuses the schema's
  `CHECK` constraints allow.
- Queries are exactly the routes' SQL — `SELECT * FROM <table> WHERE status =
  $1 ORDER BY id DESC LIMIT 50` — run after `ANALYZE`.

The seeding script is not committed (purpose-built, following
`scripts/bench-events-storage.ts`'s throwaway-database approach); the shapes
below are what matter and are easy to reproduce.

## Shape 1: status correlates with recency

Most proposals resolve (approved/rejected/executed/etc.) soon after creation,
so in practice an unresolved `pending` row is usually one of the *newest*
ids, not scattered evenly through history. Seeded round-robin (every 20th row
across the whole id range is `pending`) as a stand-in for "common, not
recency-correlated" filters generally:

```
Limit  (cost=0.42..45.84 rows=50 width=105) (actual time=0.156..0.781 rows=50 loops=1)
  Buffers: shared hit=26
  ->  Index Scan Backward using loan_proposals_pkey on loan_proposals  (cost=0.42..13553.42 rows=14920 width=105) (actual time=0.151..0.761 rows=50 loops=1)
        Filter: (status = 'pending'::text)
        Rows Removed by Filter: 931
        Buffers: shared hit=26
Planning Time: 7.136 ms
Execution Time: 0.891 ms
```

The planner drives this from `loan_proposals_pkey`, walking backward in `id`
order and filtering as it goes. Because of `LIMIT 50`, it stops as soon as it
has 50 matches — here after skipping 931 non-matching rows, sub-millisecond
regardless of how large the table is, exactly like the GIN-driven plans in
`docs/member-activity-query-plan.md`. **A plain `status` index would not be
chosen over this** for the same reason the GIN candidate there wasn't: the
existing primary-key order already matches `ORDER BY id DESC`, so there's no
cheaper access path to switch to.

## Shape 2: a small backlog of long-stuck proposals

The case the round-robin shape above doesn't model: a handful of proposals
that never resolved — created early, never voted to a conclusion, sitting
indefinitely at `pending` — while every other, newer id resolved normally.
Reseeded so `pending` exists **only** among the oldest 300 ids (100 matching
rows total out of 300 000):

**Without the index** — the backward primary-key scan from shape 1 no longer
helps, because the matching rows are all at the *opposite* end from where the
scan starts; Postgres gives up on the index path and falls back to a full
parallel sequential scan:

```
Limit  (cost=7811.23..7817.06 rows=50 width=105) (actual time=144.643..167.031 rows=50 loops=1)
  Buffers: shared hit=5320
  ->  Gather Merge  (cost=7811.23..7818.00 rows=58 width=105) (actual time=144.641..167.016 rows=50 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        ->  Sort  (cost=6811.20..6811.28 rows=29 width=105) (actual time=112.256..112.262 rows=31 loops=3)
              Sort Key: id DESC
              ->  Parallel Seq Scan on loan_proposals  (cost=0.00..6810.50 rows=29 width=105) (actual time=61.681..109.312 rows=37 loops=3)
                    Filter: (status = 'pending'::text)
                    Rows Removed by Filter: 99963
                    Buffers: shared hit=5248
Planning Time: 3.818 ms
Execution Time: 168.441 ms
```

**With `loan_proposals_status_idx ON loan_proposals (status)`** — the planner
switches to an index scan straight to the matching rows:

```
Limit  (cost=440.64..440.77 rows=50 width=105) (actual time=0.504..0.523 rows=50 loops=1)
  Buffers: shared hit=11 read=3
  ->  Sort  (cost=440.64..440.99 rows=140 width=105) (actual time=0.501..0.509 rows=50 loops=1)
        Sort Key: id DESC
        Sort Method: top-N heapsort  Memory: 38kB
        ->  Index Scan using loan_proposals_status_idx on loan_proposals  (cost=0.42..435.99 rows=140 width=105) (actual time=0.100..0.264 rows=110 loops=1)
              Index Cond: (status = 'pending'::text)
              Buffers: shared hit=8 read=3
Planning Time: 4.677 ms
Execution Time: 0.826 ms
```

**168ms → 0.8ms, 5320 buffer hits → 11.** `treasury_proposals` shows the
identical pattern under the same reseed.

## Conclusion: index added

Unlike `docs/member-activity-query-plan.md`'s GIN candidate, this index *is*
chosen by the planner, and for exactly the query shape this DAO will actually
run: "show me what's still pending" is precisely the query where matches
cluster among old, otherwise-resolved history rather than recent activity.
Cost is modest — `loan_proposals_status_idx` is 2088 kB against a 52 MB table
at 300k rows (~4%), a single-column btree with cheap maintenance on write.

`src/db/schema.sql` and migration `0035_proposal_status_indexes.sql` add
`loan_proposals_status_idx` and `treasury_proposals_status_idx`.

## Revisit

If `loan_proposals`/`treasury_proposals` ever grow large enough that even the
indexed path matters for write throughput (unlikely — proposal volume is
orders of magnitude below raw event volume; see `docs/events-storage.md`'s
growth model), re-measure with `EXPLAIN (ANALYZE, BUFFERS)` the same way
before changing anything further.
