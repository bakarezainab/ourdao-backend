import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #505: operators need to see how close a contract is to escalation,
// but quarantine_state.error_message holds handler exception text and must
// never leave the process (same rule as /api/admin/failed-events).
describe('GET /api/admin/quarantine-state (issue #505)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  afterAll(closeDb)

  it('is unauthenticated and reports failure counts and escalation state for every contract', async () => {
    await query(
      `INSERT INTO quarantine_state (contract_id, failures, error_message, escalated_at)
       VALUES ('CA', 3, 'secret handler stack trace', now() - interval '30 seconds'),
              ('CB', 1, 'another secret', NULL)`
    )

    const res = await app.inject({ method: 'GET', url: '/api/admin/quarantine-state' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { contract_id: 'CA', failures: 3, escalated: true, escalated_at: expect.any(String) },
      { contract_id: 'CB', failures: 1, escalated: false, escalated_at: null },
    ])
    expect(res.payload).not.toContain('secret handler stack trace')
    expect(res.payload).not.toContain('another secret')
  })

  it('scopes the response to one contract with ?contract=', async () => {
    await query(
      `INSERT INTO quarantine_state (contract_id, failures, escalated_at)
       VALUES ('CA', 2, NULL), ('CB', 4, now())`
    )

    const res = await app.inject({ method: 'GET', url: '/api/admin/quarantine-state?contract=CB' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { contract_id: 'CB', failures: 4, escalated: true, escalated_at: expect.any(String) },
    ])
  })

  it('returns an empty array when no quarantine state has been recorded', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/quarantine-state' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('rejects an invalid repeated contract filter instead of silently dropping it', async () => {
    await query(
      `INSERT INTO quarantine_state (contract_id, failures) VALUES ('CA', 1)`
    )

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/quarantine-state?contract=CA&contract=CB',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: expect.any(String) })
  })
})
