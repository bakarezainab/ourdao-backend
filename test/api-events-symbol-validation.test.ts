import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #592: GET /api/events's ?symbol= filter now validates against the
// known event catalog (EVENT_FIELDS), matching the strict enum validation
// GET /members/:address/activity already applies to the same-shaped
// parameter (issue #193) — a typo'd symbol is a 400, not a silently empty page.
describe('API: GET /api/events ?symbol= validation (issue #592)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()

    await query(`
      INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data) VALUES
      ('1', 100, now(), 'C1', 'loan_req', '[]', '[]')
    `)
  })
  afterAll(closeDb)

  it('rejects an unrecognized ?symbol= with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?symbol=loan_reqq' })
    expect(res.statusCode).toBe(400)
    // Fastify's querystring schema (the enum documented in OpenAPI) rejects
    // it first; the handler's own isKnownSymbol check is the fallback. Either
    // way the error names the parameter (same convention as
    // test/api-member-activity-symbol.test.ts's equivalent case).
    expect(res.json().error).toMatch(/symbol/)
  })

  it('still returns matching rows for a real, known symbol', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?symbol=loan_req' })
    expect(res.statusCode).toBe(200)
    expect(res.json().events).toHaveLength(1)
  })

  it('rejects an empty ?symbol=, matching /members/:address/activity', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events?symbol=' })
    expect(res.statusCode).toBe(400)
  })
})
