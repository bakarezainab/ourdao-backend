import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { pool } from '../src/db/index.js'
import { server as rpcServer } from '../src/stellar/rpc.js'
import { config } from '../src/config.js'
import { closeDb, resetDb } from './db.js'

// Issue #477: exercise /health/dependencies' per-dependency status logic.
describe('GET /health/dependencies status logic', () => {
  let app: FastifyInstance
  const http = config.http as { readyCheckTimeoutMs: number }
  const originalTimeout = http.readyCheckTimeoutMs

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    http.readyCheckTimeoutMs = originalTimeout
    await app.close()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('reports ok for both dependencies when both are healthy', async () => {
    vi.spyOn(rpcServer, 'getHealth').mockResolvedValue({ status: 'healthy' } as Awaited<ReturnType<typeof rpcServer.getHealth>>)
    const res = await app.inject({ method: 'GET', url: '/health/dependencies' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.postgres.status).toBe('ok')
    expect(body.rpc.status).toBe('ok')
    expect(typeof body.postgres.latencyMs).toBe('number')
    expect(typeof body.rpc.latencyMs).toBe('number')
  })

  it('reports postgres error but still answers 200 when Postgres fails', async () => {
    vi.spyOn(rpcServer, 'getHealth').mockResolvedValue({ status: 'healthy' } as Awaited<ReturnType<typeof rpcServer.getHealth>>)
    const original = pool.query.bind(pool)
    vi.spyOn(pool, 'query').mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (text === 'SELECT 1') return Promise.reject(new Error('connection refused'))
      return (original as (...args: unknown[]) => unknown)(text, ...rest)
    }) as typeof pool.query)
    const res = await app.inject({ method: 'GET', url: '/health/dependencies' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.postgres.status).toBe('error')
    expect(body.postgres.error).toBe('connection refused')
    expect(body.rpc.status).toBe('ok')
  })

  it('reports rpc degraded when getHealth is not healthy', async () => {
    vi.spyOn(rpcServer, 'getHealth').mockResolvedValue({ status: 'unhealthy' } as unknown as Awaited<ReturnType<typeof rpcServer.getHealth>>)
    const res = await app.inject({ method: 'GET', url: '/health/dependencies' })
    expect(res.statusCode).toBe(200)
    expect(res.json().rpc.status).toBe('degraded')
  })

  it('reports rpc error when getHealth exceeds READY_CHECK_TIMEOUT_MS', async () => {
    http.readyCheckTimeoutMs = 50
    vi.spyOn(rpcServer, 'getHealth').mockImplementation(() => new Promise(() => {}))
    const res = await app.inject({ method: 'GET', url: '/health/dependencies' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.rpc.status).toBe('error')
    expect(body.rpc.error).toBe('timed out')
    expect(body.postgres.status).toBe('ok')
  })
})
