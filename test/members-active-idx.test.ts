import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('members_active_joined_ledger_idx (issue #607)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it("serves GET /api/members' query with an index scan, not a seq scan + sort", async () => {
    // Large enough that a seq scan + sort is no longer the planner's cheapest
    // option (see docs/members-active-idx-query-plan.md for the full
    // before/after measurement) -- a small table would make this assertion
    // flaky, since Postgres reasonably prefers a seq scan there regardless
    // of which indexes exist.
    await query(
      `INSERT INTO members (address, joined_ledger, exited)
       SELECT 'G' || lpad(i::text, 55, '0'),
              CASE WHEN i % 10 = 0 THEN NULL ELSE 1000000 + i END,
              (i % 100 < 15)
         FROM generate_series(1, 20000) AS i`
    )
    await query('ANALYZE members')

    const plan = await query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT * FROM members
         WHERE exited = false AND joined_ledger IS NOT NULL
         ORDER BY joined_ledger DESC NULLS LAST LIMIT 50`
    )
    const text = plan.map((r) => r['QUERY PLAN']).join('\n')
    expect(text).toContain('members_active_joined_ledger_idx')
    expect(text).not.toMatch(/Seq Scan/)
    // The index's own sort order must satisfy ORDER BY directly -- if this
    // regresses to a plain `(joined_ledger DESC)` index (defaulting to NULLS
    // FIRST), the planner falls back to a Sort node even though it picks the
    // index for the scan.
    expect(text).not.toMatch(/Sort/)
  })

  it("doesn't replace members_active_idx -- /api/stats' broader exited-only count still needs it", async () => {
    // Every row here has joined_ledger IS NULL, so
    // members_active_joined_ledger_idx's predicate can't match any of them --
    // only members_active_idx (exited = false, no joined_ledger condition)
    // can serve this count. Most rows are exited so the index's selectivity
    // actually pays off (an even split makes a seq scan competitive and the
    // assertion flaky, same reasoning as the scale note above).
    await query(
      `INSERT INTO members (address, joined_ledger, exited)
       SELECT 'G' || lpad(i::text, 55, '0'), NULL, (i % 100 >= 5)
         FROM generate_series(1, 200000) AS i`
    )
    await query('ANALYZE members')

    const plan = await query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT count(*) FROM members WHERE exited = false`
    )
    const text = plan.map((r) => r['QUERY PLAN']).join('\n')
    expect(text).toContain('members_active_idx')
  })
})
