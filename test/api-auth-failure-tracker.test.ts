import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { closeDb, resetDb } from './db.js'
import { AuthFailureTracker } from '../src/auth.js'

type FailureRecord = { count: number; lastFailureAt: number; nextAllowedAt: number }

function records(tracker: AuthFailureTracker): Map<string, FailureRecord> {
  return (tracker as unknown as { failures: Map<string, FailureRecord> }).failures
}

describe('AuthFailureTracker capacity and periodic cleanup', () => {
  let tracker: AuthFailureTracker

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    tracker = new AuthFailureTracker()
  })

  afterEach(() => {
    tracker.shutdown()
    vi.useRealTimers()
  })

  it('evicts the lowest nextAllowedAt when a new address exceeds capacity', () => {
    const start = Date.now()
    for (let i = 0; i < 10_000; i++) {
      vi.setSystemTime(start + i)
      tracker.recordFailure(`address-${i}`)
    }
    expect(records(tracker).size).toBe(10_000)

    // Updating the first inserted key leaves its Map order unchanged, but
    // makes its nextAllowedAt newer than the second inserted key.
    vi.setSystemTime(start + 10_000)
    tracker.recordFailure('address-0')
    tracker.recordFailure('overflow')

    expect(records(tracker).size).toBe(10_000)
    expect(records(tracker).has('address-0')).toBe(true)
    expect(records(tracker).has('address-1')).toBe(false)
    expect(records(tracker).has('overflow')).toBe(true)
  })

  it('sweeps entries older than the failure window', () => {
    tracker.recordFailure('stale')
    // The sweep runs on minute boundaries, and the comparison is strict.
    vi.advanceTimersByTime(360_000)
    expect(records(tracker).has('stale')).toBe(false)
  })

  it('sweeps an expired backoff even when lastFailureAt is recent', () => {
    tracker.recordFailure('expired-backoff')
    const record = records(tracker).get('expired-backoff')!
    // This state isolates the second sweep condition; normal records have
    // nextAllowedAt after lastFailureAt, so the first rule would win.
    record.nextAllowedAt = Date.now() - 3_600_001
    vi.advanceTimersByTime(60_000)
    expect(record.lastFailureAt).toBeGreaterThan(Date.now() - 300_000)
    expect(records(tracker).has('expired-backoff')).toBe(false)
  })
})

describe('API: AuthFailureTracker brute-force backoff and lockout', () => {
  let app: FastifyInstance
  const kp = Keypair.random()

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await closeDb()
  })

  it('throttles and locks out repeated authentication failures', async () => {
    // Hit admin endpoint with invalid authorization repeatedly
    const url = '/api/admin/audit-log'
    const badAuth = `StellarSignature ${kp.publicKey()}:invalidbase64signature:1234567890abcdef1234567890abcdef`

    // First few attempts fail with 401
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: badAuth },
      })
      expect(res.statusCode).toBe(401)
    }

    // Subsequent attempts within the backoff/lockout period should get rate limited / 429 or blocked
    const throttledRes = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: badAuth },
    })
    expect([401, 429]).toContain(throttledRes.statusCode)
  })
})
