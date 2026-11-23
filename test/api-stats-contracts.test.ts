import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { config } from '../src/config.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('GET /api/stats per-contract health (issue #500)', () => {
  let app: FastifyInstance
  const originalIds = [...config.stellar.contractIds]

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterEach(async () => {
    config.stellar.contractIds.splice(0, config.stellar.contractIds.length, ...originalIds)
    await app.close()
  })

  afterAll(closeDb)

  it('keeps the single-contract response shape unchanged', async () => {
    config.stellar.contractIds.splice(0, config.stellar.contractIds.length, 'CA')
    const res = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).not.toHaveProperty('contracts')
  })

  it('reports each configured contract while retaining aggregate top-level fields', async () => {
    config.stellar.contractIds.splice(0, config.stellar.contractIds.length, 'CA', 'CB', 'CC')
    await query(`INSERT INTO indexer_cursor (contract_id, last_ledger, observed_tip_ledger, updated_at)
      VALUES ('CA', 100, 120, now() - interval '2 minutes'),
             ('CB', 200, 205, now() - interval '1 minute')`)
    await query(`INSERT INTO failed_events (event_id, contract_id, symbol, ledger, error, resolved_at)
      VALUES ('a-1', 'CA', 'joined', 100, 'boom', NULL),
             ('a-2', 'CA', 'joined', 101, 'boom', now()),
             ('b-1', 'CB', 'joined', 200, 'boom', NULL)`)
    await query(`INSERT INTO quarantine_state (contract_id, escalated_at)
      VALUES ('CA', now() - interval '30 seconds')`)
    await query(`INSERT INTO reorg_halts (contract_id, detail)
      VALUES ('CB', 'fork detected')`)

    const res = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.lastIndexedLedger).toBe(100)
    expect(body.observedTipLedger).toBe(120)
    expect(body.quarantinedEvents).toBe(2)
    expect(body.reorgDetected).toBe(true)
    expect(body.contracts.CA).toMatchObject({
      lastIndexedLedger: 100,
      observedTipLedger: 120,
      ledgersBehind: 20,
      quarantinedEvents: 1,
      reorgDetected: false,
    })
    expect(body.contracts.CA.quarantineEscalatedAt).toEqual(expect.any(String))
    expect(body.contracts.CB).toMatchObject({
      lastIndexedLedger: 200,
      observedTipLedger: 205,
      ledgersBehind: 5,
      quarantinedEvents: 1,
      quarantineEscalatedAt: null,
      reorgDetected: true,
    })
    expect(body.contracts.CC).toEqual({
      lastIndexedLedger: null,
      observedTipLedger: null,
      ledgersBehind: null,
      quarantinedEvents: 0,
      quarantineEscalatedAt: null,
      reorgDetected: false,
    })
  })
})
