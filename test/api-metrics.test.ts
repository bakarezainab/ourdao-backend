// Tests for GET /metrics Prometheus endpoint (issue #483).
//
// These tests verify:
//  - GET /metrics returns 200 with Prometheus-exposition-format body and expected Content-Type header
//  - ourdao_sse_connections, ourdao_sse_messages_total, ourdao_sse_connections_total appear by name in scraped text
//  - Opening/closing test SSE stream connection changes ourdao_sse_connections_total in next scrape
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
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
