import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query } from '../src/db/index.js'
import { SEED_SCALE, seedDatabase } from '../scripts/bench-api-latency.js'
import { closeDb, resetDb } from './db.js'

async function count(table: string): Promise<number> {
  const rows = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`)
  return Number(rows[0]?.n ?? 0)
}

// Issue #471: the benchmark's seeding step was a TODO, so `npm run bench:api`
// measured whatever happened to be in the database.
describe('bench:api seeding (issue #471)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('seeds an empty database to the documented scale', async () => {
    await seedDatabase()

    expect(await count('members')).toBeGreaterThanOrEqual(100)
    expect(await count('loan_proposals')).toBeGreaterThanOrEqual(50)
    expect(await count('loans')).toBeGreaterThanOrEqual(30)
    expect(await count('treasury_proposals')).toBe(SEED_SCALE.treasuryProposals)
    expect(await count('interest_distributions')).toBe(SEED_SCALE.interestDistributions)
  })

  it('is idempotent: a second run tops up nothing', async () => {
    await seedDatabase()
    const before = await count('members')
    await seedDatabase()

    expect(await count('members')).toBe(before)
    expect(await count('loans')).toBe(SEED_SCALE.loans)
  })
})
