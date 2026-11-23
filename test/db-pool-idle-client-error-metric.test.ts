import { describe, expect, it } from 'vitest'
import { pool } from '../src/db/index.js'
import { dbPoolIdleClientErrorsTotal, metricsRegistry } from '../src/api/metrics.js'
import { buildServer } from '../src/api/server.js'
import { resetDb } from './db.js'

// Issue #595: `pool.on('error', ...)` (src/db/index.ts) only logged a
// background idle-client error via console.error, with no Prometheus
// counter alongside it. pg's Pool surfaces this for a connection that fails
// outside any in-flight query, which is exactly what's forced here by
// emitting a synthetic 'error' event directly on the shared pool, the same
// way pg itself would.
describe('db pool idle-client error metric (issue #595)', () => {
  it('increments ourdao_db_pool_idle_client_errors_total when the pool emits "error"', async () => {
    const before = (await dbPoolIdleClientErrorsTotal.get()).values[0]?.value ?? 0

    pool.emit('error', new Error('synthetic idle client error'))

    const after = (await dbPoolIdleClientErrorsTotal.get()).values[0]?.value ?? 0
    expect(after).toBe(before + 1)
  })

  it('exposes the counter on GET /metrics', async () => {
    await resetDb()
    const app = await buildServer()
    await app.ready()

    pool.emit('error', new Error('synthetic idle client error'))

    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('ourdao_db_pool_idle_client_errors_total')
    expect(metricsRegistry.getSingleMetric('ourdao_db_pool_idle_client_errors_total')).toBeDefined()
  })
})
