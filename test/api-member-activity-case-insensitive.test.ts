import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #263: GET /api/members/:address/activity normalizes mixed-case
// addresses to uppercase before querying, so lookups are case-insensitive
// (Stellar addresses are case-insensitive but Postgres stores canonical
// uppercase StrKey strings).

const MEMBER_UPPER = Keypair.random().publicKey()
const MEMBER_LOWER = MEMBER_UPPER.toLowerCase()
const MEMBER_MIXED = MEMBER_UPPER.substring(0, 10).toLowerCase() + MEMBER_UPPER.substring(10)

let seq = 0

async function ev(ledger: number, symbol: string, data: unknown[]): Promise<void> {
  seq += 1
  await query(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash)
     VALUES ($1, $2, to_timestamp($3), 'CTEST', $4, $5, $6, $7)`,
    [
      `${String(ledger).padStart(10, '0')}-${String(seq).padStart(10, '0')}`,
      ledger,
      1_700_000_000 + ledger,
      symbol,
      JSON.stringify([symbol]),
      JSON.stringify(data),
      `tx-${ledger}-${seq}`,
    ]
  )
}

describe('GET /api/members/:address/activity case normalization (issue #263)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
    // Store events with uppercase address (canonical form)
    await ev(10, 'joined', [MEMBER_UPPER, '10'])
    await ev(20, 'loan_vote', [7, MEMBER_UPPER, true, null])
    await ev(30, 'staked', [MEMBER_UPPER, '5', '5'])
  })
  afterAll(closeDb)

  it('returns activity when querying with uppercase address', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/members/${MEMBER_UPPER}/activity` })
    expect(res.statusCode).toBe(200)
    expect(res.json().activity).toHaveLength(3)
  })

  it('returns activity when querying with lowercase address', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/members/${MEMBER_LOWER}/activity` })
    expect(res.statusCode).toBe(200)
    expect(res.json().activity).toHaveLength(3)
  })

  it('returns activity when querying with mixed-case address', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/members/${MEMBER_MIXED}/activity` })
    expect(res.statusCode).toBe(200)
    expect(res.json().activity).toHaveLength(3)
  })

  it('rejects invalid address format before hitting database', async () => {
    const invalid = 'not-a-stellar-address'
    const res = await app.inject({ method: 'GET', url: `/api/members/${invalid}/activity` })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/invalid Stellar address/i)
  })

  it('symbol filter works with case-insensitive address', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/members/${MEMBER_LOWER}/activity?symbol=loan_vote`,
    })
    expect(res.statusCode).toBe(200)
    const { activity } = res.json()
    expect(activity).toHaveLength(1)
    expect(activity[0].symbol).toBe('loan_vote')
  })
})
