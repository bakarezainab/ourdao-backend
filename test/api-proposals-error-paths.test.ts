// Error-path tests for GET /proposals/loan/:id and GET /proposals/treasury/:id (issue #482).
//
// These tests verify:
//  - Non-numeric, zero, or negative :id returns 400 with documented error message
//  - Well-formed but nonexistent id returns 404 with error: 'loan proposal not found' / 'treasury proposal not found'
//  - Existing proposal returns with tallies_weighted: false matching list endpoints' shape
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('GET /proposals/loan/:id error paths (issue #482)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    await closeDb()
  })

  it('returns 400 with "invalid proposal id" for non-numeric id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/proposals/loan/abc',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid proposal id' })
  })

  it('returns 400 with "invalid proposal id" for zero id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/proposals/loan/0',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid proposal id' })
  })

  it('returns 400 with "invalid proposal id" for negative id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/proposals/loan/-1',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid proposal id' })
  })

  it('returns 404 with "loan proposal not found" for nonexistent id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/proposals/loan/99999',
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'loan proposal not found' })
  })

  it('returns 200 with existing proposal and tallies_weighted: false', async () => {
    const kp = Keypair.random()
    const addr = kp.publicKey()
    await query(
      `INSERT INTO loan_proposals (id, borrower, amount, status)
       VALUES (42, $1, 500, 'pending')`,
      [addr],
    )

    const res = await app.inject({
      method: 'GET',
      url: '/api/proposals/loan/42',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(42)
    expect(body.borrower).toBe(addr)
    expect(body.amount).toBe(500)
    expect(body.status).toBe('pending')
    expect(body.tallies_weighted).toBe(false)
  })
})

describe('GET /proposals/treasury/:id error paths (issue #482)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    await closeDb()
  })

  it('returns 400 with "invalid proposal id" for non-numeric id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/proposals/treasury/xyz',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid proposal id' })
  })

  it('returns 400 with "invalid proposal id" for zero id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/proposals/treasury/0',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid proposal id' })
  })

  it('returns 400 with "invalid proposal id" for negative id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/proposals/treasury/-5',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid proposal id' })
  })

  it('returns 404 with "treasury proposal not found" for nonexistent id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/proposals/treasury/88888',
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'treasury proposal not found' })
  })

  it('returns 200 with existing proposal and tallies_weighted: false', async () => {
    await query(
      `INSERT INTO treasury_proposals (id, amount, destination, status)
       VALUES (7, 1000, 'GBFAKE', 'pending')`
    )

    const res = await app.inject({
      method: 'GET',
      url: '/api/proposals/treasury/7',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(7)
    expect(body.amount).toBe(1000)
    expect(body.destination).toBe('GBFAKE')
    expect(body.status).toBe('pending')
    expect(body.tallies_weighted).toBe(false)
  })
})
