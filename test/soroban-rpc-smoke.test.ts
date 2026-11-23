import { describe, expect, it } from 'vitest'
import { rpc } from '@stellar/stellar-sdk'
import { decodeEvent, EVENT_FIELDS, FIXTURE_SDK_VERSION, type DecodedEvent } from '../src/stellar/events.js'
import { pool } from '../src/db/index.js'
import { resetDb, closeDb } from './db.js'
import { applyEvent } from '../src/indexer/handlers.js'

/**
 * Opt-in Soroban RPC response shape smoke test (#206).
 *
 * Excluded from ordinary PR runs to protect CI against public RPC latency,
 * rate-limits, and network hiccups. Triggered on a schedule or explicitly via:
 *   RUN_RPC_SMOKE=true CONTRACT_ID=C... npm run test:smoke
 */
const shouldRun = process.env.RUN_RPC_SMOKE === 'true'

describe.runIf(shouldRun)('Soroban RPC wire response smoke test (#206)', () => {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
  const contractId = process.env.CONTRACT_ID || ''
  const server = new rpc.Server(rpcUrl)

  it('validates the SDK fixture version is pinned and documented', () => {
    expect(FIXTURE_SDK_VERSION).toBe('16.0.1')
  })

  it('queries real RPC getLatestLedger and getEvents to verify wire format compatibility', async () => {
    // 1. Verify getLatestLedger wire shape
    const latestLedgerResp = await server.getLatestLedger()
    expect(typeof latestLedgerResp.sequence).toBe('number')
    expect(latestLedgerResp.sequence).toBeGreaterThan(0)
    expect(typeof latestLedgerResp.protocolVersion).toBe('number')

    if (!contractId) {
      // If no contract id is passed, we verified the RPC connectivity and latest ledger shape.
      return
    }

    // 2. Poll real events for the contract
    const startLedger = Math.max(1, latestLedgerResp.sequence - 1000)
    const eventsResp = await server.getEvents({
      startLedger,
      filters: [{ type: 'contract', contractIds: [contractId] }],
      limit: 10,
    })

    expect(Array.isArray(eventsResp.events)).toBe(true)

    // 3. If events are returned, assert that real wire events decode into the expected shape
    for (const ev of eventsResp.events) {
      expect(typeof ev.id).toBe('string')
      expect(typeof ev.type).toBe('string')
      expect(typeof ev.ledger).toBe('number')
      expect(typeof ev.ledgerClosedAt).toBe('string')
      expect(ev.contractId).toBeDefined()
      expect(Array.isArray(ev.topic)).toBe(true)
      expect(ev.value).toBeDefined()

      const decoded: DecodedEvent = decodeEvent(ev)
      expect(decoded.id).toBe(ev.id)
      expect(decoded.ledger).toBe(ev.ledger)
      expect(decoded.contractId).toBe(typeof ev.contractId === 'string' ? ev.contractId : String(ev.contractId))
      expect(Array.isArray(decoded.data)).toBe(true)
      expect(typeof decoded.fields).toBe('object')

      // If symbol is in the catalog, verify named fields match positional mapping
      if (decoded.symbol in EVENT_FIELDS) {
        const expectedFieldNames = EVENT_FIELDS[decoded.symbol as keyof typeof EVENT_FIELDS]
        for (const fieldName of expectedFieldNames) {
          expect(decoded.fields).toHaveProperty(fieldName)
        }
      }

      // If a database is available, fold the real decoded event against Postgres
      if (process.env.TEST_DATABASE_URL) {
        await resetDb()
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await applyEvent(client, decoded)
          await client.query('COMMIT')
        } finally {
          client.release()
        }
      }
    }
  })
})
