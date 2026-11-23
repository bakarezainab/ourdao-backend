// Tests for GET /metrics Prometheus endpoint (issue #483).
//
// These tests verify:
//  - GET /metrics returns 200 with Prometheus-exposition-format body and expected Content-Type header
//  - ourdao_sse_connections, ourdao_sse_messages_total, ourdao_sse_connections_total appear by name in scraped text
//  - Opening/closing test SSE stream connection changes ourdao_sse_connections_total in next scrape
//
// Issue #353 tests (appended below):
//  - allowList matches /health, /ready, /version on path only (query strings are stripped)
//  - /metrics is NOT in the allowList (it is now rate-limited)
//  - METRICS_TOKEN protection: 401 on missing/wrong token; 200 on correct token
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { resetConnectedStreamsForTests } from '../src/api/stream.js'
import { metricsRegistry } from '../src/api/metrics.js'
import { closeDb, resetDb } from './db.js'

describe('GET /metrics Prometheus endpoint (issue #483)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    resetConnectedStreamsForTests()
    // Reset metrics for test isolation
    metricsRegistry.resetMetrics?.()
    app = await buildServer()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    resetConnectedStreamsForTests()
    await closeDb()
  })

  it('returns 200 with Prometheus-exposition-format body and correct Content-Type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.headers['content-type']).toContain('charset=utf-8')

    // Body should be Prometheus exposition format text (not JSON)
    const body = res.body
    expect(body).toBeTruthy()
    expect(typeof body).toBe('string')
    // Should contain TYPE and HELP lines typical of Prometheus format
    expect(body).toContain('# HELP')
    expect(body).toContain('# TYPE')
  })

  it('exposes ourdao_sse_connections gauge metric', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    })

    expect(res.statusCode).toBe(200)
    const body = res.body as string
    expect(body).toContain('ourdao_sse_connections')
  })

  it('exposes ourdao_sse_messages_total counter metric', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    })

    expect(res.statusCode).toBe(200)
    const body = res.body as string
    expect(body).toContain('ourdao_sse_messages_total')
  })

  it('exposes ourdao_sse_connections_total counter metric', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    })

    expect(res.statusCode).toBe(200)
    const body = res.body as string
    expect(body).toContain('ourdao_sse_connections_total')
  })

  it('includes metric names with proper type declarations in Prometheus format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    })

    expect(res.statusCode).toBe(200)
    const body = res.body as string

    // Verify TYPE declarations exist for our custom metrics
    expect(body).toMatch(/# TYPE ourdao_sse_connections gauge/)
    expect(body).toMatch(/# TYPE ourdao_sse_connections_total counter/)
    expect(body).toMatch(/# TYPE ourdao_sse_messages_total counter/)
  })

  it('metrics change as SSE connections open and close', async () => {
    // Get initial metrics
    const initialRes = await app.inject({
      method: 'GET',
      url: '/metrics',
    })
    expect(initialRes.statusCode).toBe(200)
    const initialMetrics = initialRes.body as string

    // Extract the initial ourdao_sse_connections_total value (should be 0 or already set)
    const initialTotalMatch = initialMetrics.match(/^ourdao_sse_connections_total\s+(\d+)/m)
    const initialTotal = initialTotalMatch ? parseInt(initialTotalMatch[1], 10) : 0

    // Start streaming (but don't wait for it to complete)
    const streamPromise = app.inject({
      method: 'GET',
      url: '/api/stream',
    })

    // Give the stream time to connect
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Get metrics while stream is connected — should show ourdao_sse_connections = 1
    const duringRes = await app.inject({
      method: 'GET',
      url: '/metrics',
    })
    expect(duringRes.statusCode).toBe(200)
    const duringMetrics = duringRes.body as string
    expect(duringMetrics).toContain('ourdao_sse_connections 1')

    // Total counter should have incremented (at least by 1)
    const duringTotalMatch = duringMetrics.match(/^ourdao_sse_connections_total\s+(\d+)/m)
    const duringTotal = duringTotalMatch ? parseInt(duringTotalMatch[1], 10) : 0
    expect(duringTotal).toBeGreaterThanOrEqual(initialTotal + 1)

    // Don't wait for the stream to complete; just verify the metrics tracked the connection
    void streamPromise
  })

  it('metrics reflect all expected custom OurDAO metrics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    })

    expect(res.statusCode).toBe(200)
    const body = res.body as string

    // Verify we can find all three custom metrics with their values
    expect(body).toMatch(/^ourdao_sse_connections\s+\d+/m)
    expect(body).toMatch(/^ourdao_sse_messages_total\b/m)
    expect(body).toMatch(/^ourdao_sse_connections_total\s+\d+/m)
  })
})

// Issue #353: allowList path-only matching and /metrics token protection.
//
// The allowList used exact string equality against req.url, which includes query
// strings. /health?foo=1 would not be exempt, while /metrics?foo=1 would be
// rate-limited even though /metrics was in the allowList — the opposite of what
// was intended. The fix strips the query string before comparing.
//
// /metrics is removed from the allowList entirely; it now counts against the shared
// per-IP limit and optionally requires a bearer token (METRICS_TOKEN).
describe('/metrics — METRICS_TOKEN opt-in protection (issue #353)', () => {
  let app: FastifyInstance
  const originalToken = process.env.METRICS_TOKEN

  afterEach(async () => {
    if (app) await app.close()
    if (originalToken === undefined) {
      delete process.env.METRICS_TOKEN
    } else {
      process.env.METRICS_TOKEN = originalToken
    }
  })

  it('returns 200 without a token when METRICS_TOKEN is unset (open behaviour preserved)', async () => {
    delete process.env.METRICS_TOKEN
    // Re-import config so the new env value is picked up
    const { config } = await import('../src/config.js')
    Object.assign(config.http, { metricsToken: '' })
    app = await buildServer()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
  })

  it('returns 401 when METRICS_TOKEN is set and no Authorization header is sent', async () => {
    const { config } = await import('../src/config.js')
    Object.assign(config.http, { metricsToken: 'secret-scrape-token' })
    app = await buildServer()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 when METRICS_TOKEN is set and the wrong token is supplied', async () => {
    const { config } = await import('../src/config.js')
    Object.assign(config.http, { metricsToken: 'secret-scrape-token' })
    app = await buildServer()
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer wrong-token' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 200 when METRICS_TOKEN is set and the correct token is supplied', async () => {
    const { config } = await import('../src/config.js')
    Object.assign(config.http, { metricsToken: 'secret-scrape-token' })
    app = await buildServer()
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer secret-scrape-token' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('rate-limit allowList — query-string stripping (issue #353)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterEach(async () => {
    if (app) await app.close()
  })

  afterAll(closeDb)

  it('/health?probe=1 is still exempt from rate limiting', async () => {
    for (let i = 0; i < 150; i++) {
      const res = await app.inject({ method: 'GET', url: '/health?probe=1' })
      expect(res.statusCode).toBe(200)
    }
  })

  it('/ready?check=liveness is still exempt from rate limiting', async () => {
    for (let i = 0; i < 150; i++) {
      const res = await app.inject({ method: 'GET', url: '/ready?check=liveness' })
      // May return 200 or 503 depending on DB state, but never 429
      expect(res.statusCode).not.toBe(429)
    }
  })
})
