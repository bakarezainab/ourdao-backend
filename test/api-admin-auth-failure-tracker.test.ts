import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { AuthFailureTracker } from '../src/auth.js'
import { closeDb, resetDb } from './db.js'

// Issue #603 — the /admin/* routes never passed authFailureTracker to
// authenticateRequest, so admin auth attempts never accrued backoff
// bookkeeping at all, unlike PATCH /notifications/:id/read and
// PATCH /notifications/read-all, which already did. This asserts a tracker
// shared across both route families observes a successful admin-route
// authentication the same way it already observes a notification-route one
// — by clearing a pre-seeded backoff record for that address.
async function authHeader(app: FastifyInstance, keypair: Keypair): Promise<string> {
  const address = keypair.publicKey()
  const challenge = await app.inject({ method: 'GET', url: `/api/auth/challenge?address=${address}` })
  const nonce = challenge.json().nonce as string
  const signature = keypair.sign(Buffer.from(`${nonce}:${address}`)).toString('base64')
  return `StellarSignature ${address}:${signature}:${nonce}`
}

describe('API: admin routes share the AuthFailureTracker with notification routes (issue #603)', () => {
  let app: FastifyInstance
  let tracker: AuthFailureTracker

  beforeEach(async () => {
    await resetDb()
    tracker = new AuthFailureTracker()
    app = await buildServer({ authFailureTracker: tracker })
    await app.ready()
  })
  afterAll(async () => {
    tracker.shutdown()
    await closeDb()
  })

  it('GET /api/admin/audit-log clears a pre-seeded backoff record on successful auth', async () => {
    const keypair = Keypair.random()
    const address = keypair.publicKey()

    // Seed as if a prior failed attempt had been recorded for this address.
    tracker.recordFailure(address)
    expect(tracker.isAllowed(address)).toBe(false)

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { authorization: await authHeader(app, keypair) },
    })
    expect(res.statusCode).toBe(200)

    // recordSuccess is only reachable if the route actually passed this
    // tracker instance into authenticateRequest's fifth argument.
    expect(tracker.isAllowed(address)).toBe(true)
    expect(tracker.getRemainingBackoff(address)).toBe(0)
  })

  it('PATCH /api/notifications/read-all clears the same tracker the same way (control)', async () => {
    const keypair = Keypair.random()
    const address = keypair.publicKey()

    tracker.recordFailure(address)
    expect(tracker.isAllowed(address)).toBe(false)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/read-all?address=${address}`,
      headers: { authorization: await authHeader(app, keypair) },
    })
    expect(res.statusCode).toBe(200)

    expect(tracker.isAllowed(address)).toBe(true)
    expect(tracker.getRemainingBackoff(address)).toBe(0)
  })
})
