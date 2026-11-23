# API Latency Baseline

This document records baseline latency measurements for key API endpoints (issue #220).

## Benchmark Methodology

The benchmark (`npm run bench:api` / `scripts/bench-api-latency.ts`) measures response times for endpoints the frontend actively polls:

- `GET /api/stats` — Dashboard aggregate counts (polled every 15s by frontend)
- `GET /api/loans` — Loans list
- `GET /api/proposals/loan` — Loan proposals with vote tallies
- `GET /api/members/:address/summary` — Member dashboard data

**Test conditions:**
- 100 requests per endpoint after 10 warmup requests
- Runs against a real Postgres database (not mocked)
- Reports p50, p95, min, max, and mean latency in milliseconds
- Database seeded to realistic scale (100+ members, 50+ proposals, 30+ loans)

**Why these endpoints:**
- `/api/stats` is the hottest endpoint (every tab polls it) and the most expensive (multi-subquery aggregate)
- The others are high-traffic routes with non-trivial query cost
- Together they represent the critical path for frontend responsiveness

## Baseline Results

**Not yet measured.** Seeding is implemented (see below), so `npm run bench:api` now runs at the documented scale; its printed table should replace the estimates here, together with the machine, Postgres version and Node version it was measured on.

Expected baseline (estimated from query structure, **not measured**):

| Endpoint | p50 (ms) | p95 (ms) | Notes |
|----------|----------|----------|-------|
| GET /api/stats | 15-30 | 40-60 | Cached for 5s (`STATS_CACHE_MS`); cold query is expensive |
| GET /api/loans | 5-15 | 20-30 | Indexed on `id DESC` |
| GET /api/proposals/loan | 5-15 | 20-30 | Indexed on `id DESC` |
| GET /api/members/:address/summary | 10-25 | 30-50 | Multi-table aggregation; loans limited to 100 |

These are **cold query estimates**. Actual results will be added once the benchmark is run against a seeded local Postgres.

## Interpreting Results

**What good latency looks like:**
- **p50 under 50ms**: Most requests feel instant to users
- **p95 under 200ms**: Worst-case (slow query, cold cache) is still acceptable
- **No outliers >1s**: A single slow request blocks the UI noticeably

**When to investigate:**
- p50 increases significantly (>50% regression) between baseline and a new measurement
- p95 exceeds 200ms consistently
- Max latency shows multi-second outliers

**Common causes of regression:**
- Missing or dropped index
- Unbounded query (no `LIMIT`, or `LIMIT` too high)
- Removed caching (e.g., `STATS_CACHE_MS=0`)
- Increased data size without index adjustment

## Running the Benchmark

### Locally

```bash
# Ensure DATABASE_URL points at a seeded database
npm run bench:api
```

The script first tops up the database to the documented scale (120 members, 60 loan proposals, 40 loans, 20 treasury proposals, 30 interest distributions). Seeding is idempotent: it uses fixed ids and addresses with `ON CONFLICT DO NOTHING`, so existing rows are kept and a rerun adds nothing. It then benchmarks all endpoints and prints results. The seeded member `GAAAA…AWHF` is the one the summary benchmark queries.

### In CI

The benchmark is **not** run on every PR by default—runner variance would produce noisy results that don't reflect real regressions. Instead, run it:

- **Manually** when investigating a performance issue
- **On a schedule** (e.g., nightly) to detect slow-burn regressions
- **Before and after** an indexing or caching change to validate impact

To add it to CI as an on-demand or scheduled job, add a workflow step:

```yaml
- name: API latency benchmark
  run: npm run bench:api
```

## Validating Caching and Indexing Decisions

The benchmark exists to answer:

1. **Is `/api/stats` caching effective?**  
   Set `STATS_CACHE_MS=0` and re-run—if p50 increases dramatically, caching is earning its keep.

2. **Do indexes cover the hot queries?**  
   Check `EXPLAIN ANALYZE` output for the queries behind these endpoints. An index scan is fast; a sequential scan over thousands of rows is not.

3. **Is the 100-loan cap in `/members/:address/summary` sufficient?**  
   Increase it to 500 and re-run—if latency doesn't change much, the cap isn't the bottleneck. If it doubles, the cap is load-bearing.

4. **Are vote tallies (`votes_for`/`votes_against`) a performance issue?**  
   These are `NUMERIC(40,0)` summed per query. If p95 is high and indexes are fine, the aggregation itself may need optimization (e.g., materialized view, pre-computed column).

## Baseline vs. Production

**This is a local baseline** measured under lab conditions: single API instance, dedicated Postgres, no network latency, no competing load. Production latency includes:

- **Network round-trip time** (10-50ms typical, 100ms+ for distant clients)
- **Database connection acquisition** (usually <1ms from pool, but contention adds latency)
- **Competing requests** (other API instances, the indexer, maintenance queries)
- **Cache state** (more cache hits in production after warm-up)

Multiply the baseline p50 by ~1.5-2x to estimate production p50. Use the baseline for **relative comparisons** (did this change make things faster?) rather than absolute targets.

## Next Steps

1. ~~**Implement database seeding** in `scripts/bench-api-latency.ts`~~ (done, issue #471)
2. **Run the benchmark** and record actual results here
3. **Add to CI** as a scheduled or on-demand job
4. **Re-run after indexing changes** to validate improvements
5. **Monitor production** with real latency metrics (APM, logs, `/api/stats` response times)

## Related

- `scripts/bench-api-latency.ts` — The benchmark implementation
- `scripts/bench-events-storage.ts` — Storage layer benchmark (different concern)
- `src/api/routes/index.ts` — Route handlers for benchmarked endpoints
- `docs/DEPENDENCY-LICENSES.md` — Dependency policy (unrelated, but both are policy docs)

## References

- Issue #220: No API latency baseline or performance test
- Frontend polling: `ourdao-frontend` polls `/api/stats` every 15s
- Caching: `STATS_CACHE_MS` config (default 5000ms)
- Indexes: See `src/db/schema.sql` for index definitions
