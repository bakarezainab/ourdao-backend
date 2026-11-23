import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'
import { LOAN_STATUSES } from '../src/types.js'

// Issue #593: GET /api/proposals/loan and GET /api/proposals/treasury
// previously passed ?status= straight into the query with no validation —
// a typo'd status silently returned an empty page instead of a 400,
// inconsistent with GET /api/loans's existing strict validation. Both now
// validate against the shared LOAN_PROPOSAL_STATUSES/TREASURY_PROPOSAL_STATUSES
// constants, and GET /api/loans itself now imports LOAN_STATUSES from
// src/types.ts instead of duplicating the list inline.
describe('API: ?status= validation for proposals/loan, proposals/treasury, loans (issue #593)', () => {
  let app: FastifyInstance
  const borrower = Keypair.random().publicKey()

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('rejects an unrecognized ?status= on GET /api/proposals/loan with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/proposals/loan?status=aproved' })
    expect(res.statusCode).toBe(400)
  })

  it('still filters correctly for a real, known status on GET /api/proposals/loan', async () => {
    await query(
      `INSERT INTO loan_proposals (id, borrower, amount, status) VALUES
       (1, $1, 100, 'pending'), (2, $1, 200, 'approved')`,
      [borrower],
    )
    const res = await app.inject({ method: 'GET', url: '/api/proposals/loan?status=approved' })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((p: { id: number }) => p.id)).toEqual([2])
  })

  it('rejects an unrecognized ?status= on GET /api/proposals/treasury with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/proposals/treasury?status=aproved' })
    expect(res.statusCode).toBe(400)
  })

  it('still filters correctly for a real, known status on GET /api/proposals/treasury', async () => {
    await query(
      `INSERT INTO treasury_proposals (id, amount, destination, status) VALUES
       (1, 100, 'GDEST', 'pending'), (2, 200, 'GDEST', 'executed')`,
    )
    const res = await app.inject({ method: 'GET', url: '/api/proposals/treasury?status=executed' })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((p: { id: number }) => p.id)).toEqual([2])
  })

  it('GET /api/loans behavior is unchanged after switching to the shared LOAN_STATUSES constant', async () => {
    await query(
      `INSERT INTO loans (id, borrower, amount, outstanding, status) VALUES
       (1, $1, 100, 100, 'active'), (2, $1, 200, 0, 'repaid')`,
      [borrower],
    )
    expect(LOAN_STATUSES).toEqual(['active', 'repaid', 'defaulted'])

    const invalidRes = await app.inject({ method: 'GET', url: '/api/loans?status=unknown' })
    expect(invalidRes.statusCode).toBe(400)

    const validRes = await app.inject({ method: 'GET', url: '/api/loans?status=active' })
    expect(validRes.statusCode).toBe(200)
    expect(validRes.json().map((l: { id: number }) => l.id)).toEqual([1])
  })
})
