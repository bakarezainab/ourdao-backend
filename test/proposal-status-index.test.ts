import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #605 — loan_proposals and treasury_proposals had no index on
// status despite both GET /api/proposals/loan and GET /api/proposals/treasury
// filtering on it the same way GET /api/loans does via loans_status_idx.
// docs/proposal-status-query-plan.md found that a small backlog of
// long-stuck proposals (status matches scattered among old ids rather than
// recent activity) forces a full sequential scan without this index.
describe('loan_proposals / treasury_proposals have a status index (issue #605)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('loan_proposals has loan_proposals_status_idx', async () => {
    const idx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'loan_proposals' ORDER BY indexname`
    )
    expect(idx.map((r) => r.indexname)).toContain('loan_proposals_status_idx')
  })

  it('treasury_proposals has treasury_proposals_status_idx', async () => {
    const idx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'treasury_proposals' ORDER BY indexname`
    )
    expect(idx.map((r) => r.indexname)).toContain('treasury_proposals_status_idx')
  })
})
