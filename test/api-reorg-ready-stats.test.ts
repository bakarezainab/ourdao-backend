/**
 * Issue #375 — /health and /ready multi-contract correctness.
 *
 * When CONTRACT_IDS is configured the existing single-id paths in both
 * endpoints misreported: /health returned { contract: null } and /ready only
 * inspected the id = 1 singleton row, missing contracts that had never been
 * polled. These tests verify both endpoints behave correctly in multi-contract
 * mode and that the single-contract path is unaffected.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { config } from '../src/config.js'
import { closeDb, resetDb } from './db.js'

// Issue #191: a recorded ledger discontinuity is visible over the API —
// `/ready` reports it as its own reason, distinct from `indexer_stale`, and
// `/api/stats` carries it for dashboards — until an operator clears it.

async function recordHalt(detail = 'ledger 500 hash changed', contract = 'CTEST'): Promise<void> {
  await query(
    `INSERT INTO reorg_halts (contract_id, last_ledger, last_ledger_hash, detail) VALUES ($1, 500, 'HASH_500', $2)`,
    [contract, detail]
  )
}

describe('reorg halt surfaced on /ready and /api/stats (issue #191)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('/ready reports reorg_detected with the halt details, even though the cursor is fresh', async () => {
    await query(`INSERT INTO indexer_cursor (contract_id, last_ledger, observed_tip_ledger, updated_at) VALUES ('CTEST', 500, 600, now())`)
    await recordHalt()

    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.status).toBe('not ready')
    expect(body.reason).toBe('reorg_detected')
    expect(body.reorg).toMatchObject({ contractId: 'CTEST', lastLedger: 500, detail: 'ledger 500 hash changed' })
    expect(new Date(body.reorg.detectedAt).getTime()).toBeGreaterThan(0)
    expect(body.lastIndexedLedger).toBe(500)
    expect(body.observedTipLedger).toBe(600)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('/ready distinguishes a halt from ordinary staleness and from a cold start', async () => {
    // Stale cursor alone: indexer_stale.
    await query(`INSERT INTO indexer_cursor (contract_id, last_ledger, updated_at) VALUES ('CTEST', 500, now() - interval '3 minutes')`)
    let res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.json().reason).toBe('indexer_stale')

    // Stale cursor plus a recorded halt: the halt wins — restarting the
    // worker is the wrong response, so the probe must not say "stale".
    await recordHalt()
    res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json().reason).toBe('reorg_detected')

    // No cursor at all but a halt on record: still not ready.
    await query('DELETE FROM indexer_cursor')
    res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json().reason).toBe('reorg_detected')
    expect(res.json().lastIndexedLedger).toBeNull()
  })

  it('/ready recovers once the halt is cleared, and only the latest uncleared halt is reported', async () => {
    await query(`INSERT INTO indexer_cursor (contract_id, last_ledger, updated_at) VALUES ('CTEST', 500, now())`)
    await recordHalt('older halt')
    await query(`UPDATE reorg_halts SET cleared_at = now(), cleared_by = 'reindex'`)
    let res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json().indexer).toBe('ok')

    await recordHalt('newer halt')
    res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.json().reorg.detail).toBe('newer halt')
  })

  it('/api/stats carries the halt for dashboards and drops it when cleared', async () => {
    await query(`INSERT INTO indexer_cursor (contract_id, last_ledger, updated_at) VALUES ('CTEST', 500, now())`)

    let res = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(res.statusCode).toBe(200)
    expect(res.json().reorgDetected).toBe(false)
    expect(res.json().reorgHalt).toBeNull()
    expect(res.json().indexerStale).toBe(false)

    await recordHalt('same-height fork at 500', 'CTEST')
    // The stats payload is cached per process for STATS_CACHE_MS; a fresh
    // server sees the new row.
    app = await buildServer()
    await app.ready()
    res = await app.inject({ method: 'GET', url: '/api/stats' })
    const body = res.json()
    expect(body.reorgDetected).toBe(true)
    expect(body.reorgHalt).toMatchObject({ contractId: 'CTEST', lastLedger: 500, detail: 'same-height fork at 500' })
    expect(typeof body.reorgHalt.detectedAt).toBe('string')
    // Staleness is reported independently: the cursor is fresh here.
    expect(body.indexerStale).toBe(false)

    await query(`UPDATE reorg_halts SET cleared_at = now(), cleared_by = 'operator'`)
    app = await buildServer()
    await app.ready()
    res = await app.inject({ method: 'GET', url: '/api/stats' })
    expect(res.json().reorgDetected).toBe(false)
    expect(res.json().reorgHalt).toBeNull()
import * as configModule from '../src/config.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a cursor row keyed by contract_id. The singleton id = 1 constraint is
 * relaxed here: multi-contract rows must be inserted via contract_id lookup,
 * not id = 1.  We drop the CONSTRAINT for multi-contract tests and restore it
 * after. Single-contract tests use the normal id = 1 path.
 */
async function seedCursorByContract(
  contractId: string,
  lastLedger: number,
  updatedAt: string = 'now()'
): Promise<void> {
  // Insert without relying on id = 1 — use the contract_id column so each
  // contract gets its own row (multi-contract schema assumption).
  await query(
    `INSERT INTO indexer_cursor (paging_token, last_ledger, observed_tip_ledger, contract_id, updated_at)
     VALUES (NULL, $1, $1, $2, ${updatedAt})
     ON CONFLICT (id) DO UPDATE
       SET last_ledger = $1, observed_tip_ledger = $1, contract_id = $2, updated_at = ${updatedAt}`,
    [lastLedger, contractId]
  )
}

// ---------------------------------------------------------------------------
// /health — multi-contract (issue #375)
// ---------------------------------------------------------------------------

describe('GET /health — multi-contract (issue #375)', () => {
  let app: FastifyInstance
  let configSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    await resetDb()
  })

  afterEach(async () => {
    await app?.close()
    configSpy?.mockRestore()
  })

  afterAll(closeDb)

  it('returns contracts array from CONTRACT_IDS when multiple ids are configured', async () => {
    // Temporarily override config.stellar so we don't need a real env var
    configSpy = vi.spyOn(configModule, 'config', 'get').mockReturnValue({
      ...configModule.config,
      stellar: {
        ...configModule.config.stellar,
        contractId: '',
        contractIds: ['CA111', 'CB222'],
      },
    })
    app = await buildServer()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.contracts).toEqual(['CA111', 'CB222'])
  })

  it('falls back to [contractId] array when only CONTRACT_ID is set', async () => {
    configSpy = vi.spyOn(configModule, 'config', 'get').mockReturnValue({
      ...configModule.config,
      stellar: {
        ...configModule.config.stellar,
        contractId: 'CSINGLE',
        contractIds: [],
      },
    })
    app = await buildServer()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.contracts).toEqual(['CSINGLE'])
  })

  it('returns contracts: null when neither CONTRACT_ID nor CONTRACT_IDS is set', async () => {
    configSpy = vi.spyOn(configModule, 'config', 'get').mockReturnValue({
      ...configModule.config,
      stellar: {
        ...configModule.config.stellar,
        contractId: '',
        contractIds: [],
      },
    })
    app = await buildServer()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.contracts).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// /ready — multi-contract (issue #375)
// ---------------------------------------------------------------------------

describe('GET /ready — multi-contract cursor verification (issue #375)', () => {
  let app: FastifyInstance
  let configSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    await resetDb()
  })

  afterEach(async () => {
    await app?.close()
    configSpy?.mockRestore()
  })

  afterAll(closeDb)

  function withContractIds(ids: string[]): void {
    configSpy = vi.spyOn(configModule, 'config', 'get').mockReturnValue({
      ...configModule.config,
      stellar: {
        ...configModule.config.stellar,
        contractId: '',
        contractIds: ids,
      },
    })
  }

  it('reports cold_start when no contracts have cursor rows', async () => {
    withContractIds(['CA', 'CB'])
    app = await buildServer()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ready')
    expect(body.indexer).toBe('cold_start')
    expect(body.lastIndexedLedger).toBeNull()
  })

  it('reports cold_start when only some configured contracts have cursor rows', async () => {
    // Seed only CA — CB is missing
    await seedCursorByContract('CA', 100)
    withContractIds(['CA', 'CB'])
    app = await buildServer()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ready')
    // CB has no row yet — partial start is a cold_start for the whole probe
    expect(body.indexer).toBe('cold_start')
  })

  it('reports ok when all configured contracts have fresh cursor rows', async () => {
    await seedCursorByContract('CA', 200)
    // Second contract needs its own row — override id uniqueness to allow two rows
    await query(`ALTER TABLE indexer_cursor DROP CONSTRAINT indexer_cursor_singleton`)
    try {
      await query(
        `INSERT INTO indexer_cursor (paging_token, last_ledger, observed_tip_ledger, contract_id, updated_at)
         VALUES (NULL, 200, 200, 'CB', now())`
      )
      withContractIds(['CA', 'CB'])
      app = await buildServer()
      await app.ready()

      const res = await app.inject({ method: 'GET', url: '/ready' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.status).toBe('ready')
      expect(body.indexer).toBe('ok')
    } finally {
      await query(`ALTER TABLE indexer_cursor ADD CONSTRAINT indexer_cursor_singleton CHECK (id = 1)`)
    }
  })

  it('reports 503 indexer_stale when the least-advanced contract is stale', async () => {
    await query(`ALTER TABLE indexer_cursor DROP CONSTRAINT indexer_cursor_singleton`)
    try {
      // CA is fresh
      await query(
        `INSERT INTO indexer_cursor (paging_token, last_ledger, observed_tip_ledger, contract_id, updated_at)
         VALUES (NULL, 200, 200, 'CA', now())`
      )
      // CB is stale (10 minutes ago)
      await query(
        `INSERT INTO indexer_cursor (paging_token, last_ledger, observed_tip_ledger, contract_id, updated_at)
         VALUES (NULL, 100, 100, 'CB', now() - interval '10 minutes')`
      )
      withContractIds(['CA', 'CB'])
      app = await buildServer()
      await app.ready()

      const res = await app.inject({ method: 'GET', url: '/ready' })
      expect(res.statusCode).toBe(503)
      const body = res.json()
      expect(body.status).toBe('not ready')
      expect(body.reason).toBe('indexer_stale')
    } finally {
      await query(`ALTER TABLE indexer_cursor ADD CONSTRAINT indexer_cursor_singleton CHECK (id = 1)`)
    }
  })

  it('single-contract path is unaffected: still uses id = 1 row when CONTRACT_IDS is empty', async () => {
    // Single-contract: seed id = 1 normally
    await query(`INSERT INTO indexer_cursor (id, last_ledger, updated_at) VALUES (1, 300, now())`)
    // contractIds empty → falls through to legacy path
    withContractIds([])
    app = await buildServer()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ready')
    expect(body.indexer).toBe('ok')
    expect(body.lastIndexedLedger).toBe(300)

  })

  it('issue #491: /ready and /api/stats scale estimatedLagSeconds by STELLAR_LEDGER_CLOSE_TIME_SECONDS', async () => {
    const stellar = config.stellar as { ledgerCloseTimeSeconds: number }
    const original = stellar.ledgerCloseTimeSeconds
    stellar.ledgerCloseTimeSeconds = 10
    try {
      await query(`INSERT INTO indexer_cursor (contract_id, last_ledger, observed_tip_ledger, updated_at) VALUES ('CTEST', 500, 600, now())`)

      const ready = await app.inject({ method: 'GET', url: '/ready' })
      expect(ready.statusCode).toBe(200)
      expect(ready.json().ledgersBehind).toBe(100)
      expect(ready.json().estimatedLagSeconds).toBe(1000)

      const stats = await app.inject({ method: 'GET', url: '/api/stats' })
      expect(stats.statusCode).toBe(200)
      expect(stats.json().estimatedLagSeconds).toBe(1000)
    } finally {
      stellar.ledgerCloseTimeSeconds = original
    }
  })
})
