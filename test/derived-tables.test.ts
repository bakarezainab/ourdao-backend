import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query } from '../src/db/index.js'
import { DERIVED_TABLES, resetDaoTotals } from '../src/indexer/derived-tables.js'
import { closeDb, resetDb } from './db.js'

// Issue #494: direct coverage for the DERIVED_TABLES / resetDaoTotals module.
//
// The inverse check (every table populated only by applyEvent appears in
// DERIVED_TABLES) is not automated: which tables applyEvent writes is only
// visible in handler code, not in the schema, so it can't be derived from
// information_schema without a hand-maintained allow-list that would drift
// the same way DERIVED_TABLES itself could.

describe('indexer/derived-tables (issue #494)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('resetDaoTotals zeroes every money column on the dao_totals singleton', async () => {
    await query(
      `INSERT INTO dao_totals (id, interest_collected, principal_lent, principal_repaid, value_defaulted)
       VALUES (1, 11, 22, 33, 44)
       ON CONFLICT (id) DO UPDATE SET interest_collected = 11, principal_lent = 22,
         principal_repaid = 33, value_defaulted = 44`
    )

    await resetDaoTotals({ query: (sql: string) => query(sql) })

    const rows = await query<{
      interest_collected: string
      principal_lent: string
      principal_repaid: string
      value_defaulted: string
    }>('SELECT interest_collected, principal_lent, principal_repaid, value_defaulted FROM dao_totals WHERE id = 1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      interest_collected: '0',
      principal_lent: '0',
      principal_repaid: '0',
      value_defaulted: '0',
    })
  })

  it('every table in DERIVED_TABLES exists in the migrated schema, exactly once', async () => {
    expect(new Set(DERIVED_TABLES).size).toBe(DERIVED_TABLES.length)

    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [[...DERIVED_TABLES]]
    )
    const found = new Set(rows.map((r) => r.table_name))
    const missing = DERIVED_TABLES.filter((t) => !found.has(t))
    expect(missing).toEqual([])
  })
})
