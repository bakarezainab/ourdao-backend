import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { config } from '../src/config.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #506: an operator must be able to see which configured contracts the
// worker is actually tailing, and how far behind each cursor is, without
// adding a separate health dashboard. /api/stats uses the same helper for its
// per-contract breakdown so the two views cannot disagree.
describe('GET /api/contracts (issue #506)', () => {
  let app: FastifyInstance
  const originalIds = [...config.stellar.contractIds]
  const originalContractId = config.stellar.contractId
  const originalStaleAfterMs = config.indexer.staleAfterMs

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterEach(async () => {
    config.stellar.contractIds.splice(0, config.stellar.contractIds.length, ...originalIds)
    config.stellar.contractId = originalContractId
    config.indexer.staleAfterMs = originalStaleAfterMs
    await app.close()
  })

  afterAll(closeDb)

  it('reports one entry per configured contract, including cold starts', async () => {
    config.stellar.contractIds.splice(0, config.stellar.contractIds.length, 'CA', 'CB', 'CC')
    config.indexer.staleAfterMs = 60_000
    await query(
      `INSERT INTO indexer_cursor (contract_id, last_ledger, observed_tip_ledger, updated_at)
       VALUES ('CA', 100, 120, now() - interval '3 minutes'),
              ('CB', 200, 205, now())`
    )
    await query(`INSERT INTO reorg_halts (contract_id, detail) VALUES ('CB', 'fork detected')`)

    const res = await app.inject({ method: 'GET', url: '/api/contracts' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      {
        contractId: 'CA',
        lastIndexedLedger: 100,
        observedTipLedger: 120,
        ledgersBehind: 20,
        secondsSinceUpdate: expect.any(Number),
        stale: true,
        status: 'stale',
        reorgDetected: false,
      },
      {
        contractId: 'CB',
        lastIndexedLedger: 200,
        observedTipLedger: 205,
        ledgersBehind: 5,
        secondsSinceUpdate: expect.any(Number),
        stale: false,
        status: 'ok',
        reorgDetected: true,
      },
      {
        contractId: 'CC',
        lastIndexedLedger: null,
        observedTipLedger: null,
        ledgersBehind: null,
        secondsSinceUpdate: null,
        stale: false,
        status: 'cold_start',
        reorgDetected: false,
      },
    ])
  })

  it('does not expose worker-local cursor-write failures', async () => {
    config.stellar.contractIds.splice(0, config.stellar.contractIds.length, 'CA')

    const res = await app.inject({ method: 'GET', url: '/api/contracts' })
    expect(res.statusCode).toBe(200)
    expect(res.json()[0]).not.toHaveProperty('cursorWriteFailures')
  })

  it('agrees with the per-contract breakdown in /api/stats', async () => {
    config.stellar.contractIds.splice(0, config.stellar.contractIds.length, 'CA', 'CB')
    await query(
      `INSERT INTO indexer_cursor (contract_id, last_ledger, observed_tip_ledger, updated_at)
       VALUES ('CA', 100, 120, now()), ('CB', 200, 200, now())`
    )

    const contractsRes = await app.inject({ method: 'GET', url: '/api/contracts' })
    const statsRes = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(contractsRes.statusCode).toBe(200)
    expect(statsRes.statusCode).toBe(200)

    const contracts = contractsRes.json() as Array<{ contractId: string }>
    const statsContracts = statsRes.json().contracts as Record<string, {
      lastIndexedLedger: number | null
      observedTipLedger: number | null
      ledgersBehind: number | null
      reorgDetected: boolean
    }>
    expect(Object.keys(statsContracts).sort()).toEqual(contracts.map((c) => c.contractId).sort())
    for (const contract of contracts) {
      expect(statsContracts[contract.contractId]).toMatchObject({
        lastIndexedLedger: contract.lastIndexedLedger,
        observedTipLedger: contract.observedTipLedger,
        ledgersBehind: contract.ledgersBehind,
        reorgDetected: contract.reorgDetected,
      })
    }
  })

  it('falls back to the legacy single CONTRACT_ID when CONTRACT_IDS is unset', async () => {
    config.stellar.contractIds.splice(0, config.stellar.contractIds.length)
    config.stellar.contractId = 'CLEGACY'

    const res = await app.inject({ method: 'GET', url: '/api/contracts' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      expect.objectContaining({ contractId: 'CLEGACY', status: 'cold_start' }),
    ])
  })
})
