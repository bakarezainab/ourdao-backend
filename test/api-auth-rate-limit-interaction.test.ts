import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { AuthFailureTracker } from '../src/auth.js'
import { closeDb, resetDb } from './db.js'

// Issue #507: Regression test for throttling interaction between IP-based rate limiting
// on GET /api/auth/challenge and per-address exponential failure backoff in AuthFailureTracker.
describe('API: Throttling interaction between challenge issuance and AuthFailureTracker (issue #507)', () => {
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
    await app.close()
    await closeDb()
  })

  it('demonstrates interleaved challenges from the same IP succeed while repeated signature failures trigger address backoff', async () => {
    const keypair = Keypair.random()
    const address = keypair.publicKey()
    const dummyKeypair = Keypair.random()

    // 1. User requests an initial authentication challenge from IP 192.168.1.100
    const challenge1 = await app.inject({
      method: 'GET',
      url: `/api/auth/challenge?address=${address}`,
      remoteAddress: '192.168.1.100',
    })
    expect(challenge1.statusCode).toBe(200)
    const nonce1 = challenge1.json().nonce as string
    expect(nonce1).toBeDefined()

    // 2. Several failed signature verifications associated with this address.
    // We sign with an incorrect keypair (dummyKeypair) to produce invalid signatures.
    const badSig1 = dummyKeypair.sign(Buffer.from(`${nonce1}:${address}`)).toString('base64')
    const authAttempt1 = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/read-all?address=${address}`,
      headers: { authorization: `StellarSignature ${address}:${badSig1}:${nonce1}` },
      remoteAddress: '192.168.1.100',
    })
    expect(authAttempt1.statusCode).toBe(401)
    expect(authAttempt1.json().error).toMatch(/invalid signature/i)

    // 3. Additional challenge requests from the same IP interleaved with failed verifications
    // Challenge issuance is IP-rate limited and does not accrue failure backoff.
    const challenge2 = await app.inject({
      method: 'GET',
      url: `/api/auth/challenge?address=${address}`,
      remoteAddress: '192.168.1.100',
    })
    expect(challenge2.statusCode).toBe(200)
    const nonce2 = challenge2.json().nonce as string
    expect(nonce2).toBeDefined()

    // Another failed verification with nonce2
    const badSig2 = dummyKeypair.sign(Buffer.from(`${nonce2}:${address}`)).toString('base64')
    const authAttempt2 = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/read-all?address=${address}`,
      headers: { authorization: `StellarSignature ${address}:${badSig2}:${nonce2}` },
      remoteAddress: '192.168.1.100',
    })
    expect(authAttempt2.statusCode).toBe(401)
    expect(authAttempt2.json().error).toMatch(/invalid signature/i)

    // Another challenge request from the same IP (interleaved)
    const challenge3 = await app.inject({
      method: 'GET',
      url: `/api/auth/challenge?address=${address}`,
      remoteAddress: '192.168.1.100',
    })
    expect(challenge3.statusCode).toBe(200)
    const nonce3 = challenge3.json().nonce as string
    expect(nonce3).toBeDefined()

    // 4. Subsequent authentication attempts after failure backoff is applied
    // Address should now be under backoff in the tracker
    expect(tracker.isAllowed(address)).toBe(false)
    expect(tracker.getRemainingBackoff(address)).toBeGreaterThan(0)

    // Attempting authentication with even a newly obtained nonce returns 429
    const validSig3 = keypair.sign(Buffer.from(`${nonce3}:${address}`)).toString('base64')
    const blockedAttempt = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/read-all?address=${address}`,
      headers: { authorization: `StellarSignature ${address}:${validSig3}:${nonce3}` },
      remoteAddress: '192.168.1.100',
    })
    expect(blockedAttempt.statusCode).toBe(429)
    expect(blockedAttempt.json().error).toMatch(/too many failed attempts/i)

    // However, challenge requests from the same IP still succeed (not blocked by address backoff)
    const challenge4 = await app.inject({
      method: 'GET',
      url: `/api/auth/challenge?address=${address}`,
      remoteAddress: '192.168.1.100',
    })
    expect(challenge4.statusCode).toBe(200)
  })
})
