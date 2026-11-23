// HTTP-level tests for POST /api/admin/clear-reorg (issue #480).
//
// These tests verify:
//  - Unauthenticated request is rejected with documented status/error code
//  - Authenticated call clears reorg_halts and returns expected response shape
//  - admin_audit_log row is written with correct action and details
//  - Calling when nothing to clear returns sensible "nothing to do" response
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'
import type { AdminAuditLogRow } from '../src/types.js'

// Helper: build an auth header for a Stellar keypair
async function buildAuthHeader(
  app: FastifyInstance,
  kp: ReturnType<typeof Keypair.random>
): Promise<string> {
  const challengeRes = await app.inject({
    method: 'GET',
    url: `/api/auth/challenge?address=${kp.publicKey()}`,
  })
  expect(challengeRes.statusCode).toBe(200)
  const { nonce } = challengeRes.json<{ nonce: string }>()

  const payload = Buffer.from(`${nonce}:${kp.publicKey()}`, 'utf8')
  const signature = kp.sign(payload).toString('base64')

  return `StellarSignature ${kp.publicKey()}:${signature}:${nonce}`
}

describe('POST /api/admin/clear-reorg (issue #480)', () => {
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

  it('requires authentication; rejects with invalid auth header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-reorg',
      headers: {
        authorization: 'StellarSignature GFAKE:FAKESIG:FAKENONCE',
      },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: expect.stringContaining('Authentication required') })
  })

  it('allows fallback x-admin-address header when no authorization header', async () => {
    await query(
      `INSERT INTO reorg_halts (contract_id, last_ledger, last_ledger_hash, detail)
       VALUES ('CTEST1', 100, 'HASH_100', 'test halt')`
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-reorg',
      headers: {
        'x-admin-address': 'GFALLBACK',
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.cleared).toBe(1)
    expect(body.halt?.contract_id).toBe('CTEST1')

    // Verify audit log was written with fallback address
    const auditLogs = await query<AdminAuditLogRow>(
      "SELECT * FROM admin_audit_log WHERE action = 'clear_reorg' ORDER BY id DESC"
    )
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0]!.admin_address).toBe('GFALLBACK')
  })

  it('clears reorg_halts and records audit log with authenticated request', async () => {
    const kp = Keypair.random()
    const authHeader = await buildAuthHeader(app, kp)

    await query(
      `INSERT INTO reorg_halts (contract_id, last_ledger, last_ledger_hash, detail)
       VALUES ('CTEST2', 200, 'HASH_200', 'test halt 2')`
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-reorg',
      headers: {
        authorization: authHeader,
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.cleared).toBe(1)
    expect(body.halt).toMatchObject({
      contract_id: 'CTEST2',
      last_ledger: 200,
      last_ledger_hash: 'HASH_200',
      detail: 'test halt 2',
    })

    // Verify reorg_halts was actually cleared
    const remaining = await query('SELECT COUNT(*) as cnt FROM reorg_halts')
    expect(remaining[0]!.cnt).toBe(0)

    // Verify admin_audit_log entry with correct details
    const auditLogs = await query<AdminAuditLogRow>(
      "SELECT * FROM admin_audit_log WHERE action = 'clear_reorg' ORDER BY id DESC"
    )
    expect(auditLogs).toHaveLength(1)
    const log = auditLogs[0]!
    expect(log.admin_address).toBe(kp.publicKey())
    expect(log.action).toBe('clear_reorg')
    expect(log.payload).toMatchObject({
      contract_id: 'CTEST2',
      last_ledger: 200,
      last_ledger_hash: 'HASH_200',
      detail: 'test halt 2',
      cleared: 1,
    })
  })

  it('returns cleared: 0 and halt: null when nothing to clear', async () => {
    const kp = Keypair.random()
    const authHeader = await buildAuthHeader(app, kp)

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-reorg',
      headers: {
        authorization: authHeader,
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.cleared).toBe(0)
    expect(body.halt).toBeNull()

    // Verify no audit log entry was written
    const auditLogs = await query<AdminAuditLogRow>(
      "SELECT * FROM admin_audit_log WHERE action = 'clear_reorg'"
    )
    expect(auditLogs).toHaveLength(0)
  })

  it('includes ip_address in audit log when captured from request', async () => {
    const kp = Keypair.random()
    const authHeader = await buildAuthHeader(app, kp)

    await query(
      `INSERT INTO reorg_halts (contract_id, last_ledger, last_ledger_hash, detail)
       VALUES ('CTEST3', 300, 'HASH_300', 'test halt 3')`
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-reorg',
      headers: {
        authorization: authHeader,
        'x-forwarded-for': '203.0.113.42',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().cleared).toBe(1)

    const auditLogs = await query<AdminAuditLogRow>(
      "SELECT * FROM admin_audit_log WHERE action = 'clear_reorg' ORDER BY id DESC"
    )
    expect(auditLogs).toHaveLength(1)
    // Note: the actual IP captured depends on how fastify.inject() simulates req.ip
    expect(auditLogs[0]!.ip_address).toBeTruthy()
  })
})
