// Issue #549: every exit path of the maintenance loop's tick() — a failed
// connect(), a failed run, or a throwing client constructor — must close the
// dedicated client (when one exists) and keep the loop scheduled.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import type { Client } from 'pg'
import { createDedicatedClient, pool } from '../src/db/index.js'
import { runMaintenanceLoop } from '../src/maintenance-loop.js'
import { closeDb } from './db.js'

// Nothing listens on port 1, so connect() fails fast with ECONNREFUSED.
const UNREACHABLE_URL = 'postgres://ourdao:ourdao@127.0.0.1:1/ourdao_test'

async function backendExists(pid: number): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])
  return (rowCount ?? 0) > 0
}

describe('maintenance loop: dedicated client lifecycle (issue #549)', () => {
  let controller: AbortController

  beforeEach(() => {
    controller = new AbortController()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    controller.abort()
    vi.restoreAllMocks()
  })

  afterAll(closeDb)

  it('closes the client and keeps running when connect() itself fails', async () => {
    const clients: Client[] = []
    const run = vi.fn()
    const loop = runMaintenanceLoop(controller.signal, {
      createClient: () => {
        const client = new pg.Client({ connectionString: UNREACHABLE_URL })
        vi.spyOn(client, 'end')
        clients.push(client)
        return client
      },
      run,
      intervalMs: 5,
    })

    // A second client means the loop rescheduled after the first failure.
    await vi.waitFor(() => expect(clients.length).toBeGreaterThanOrEqual(2))
    expect(run).not.toHaveBeenCalled()
    expect(clients[0].end).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(
      '[maintenance] run failed unexpectedly:',
      expect.objectContaining({ code: 'ECONNREFUSED' })
    )

    controller.abort()
    await loop.stopped
  })

  it('leaves no Postgres backend open after a run fails on a real connection', async () => {
    const pids: number[] = []
    const loop = runMaintenanceLoop(controller.signal, {
      createClient: createDedicatedClient,
      run: async (client) => {
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        pids.push(rows[0].pid)
        throw new Error('simulated maintenance failure')
      },
      intervalMs: 60_000,
    })

    await vi.waitFor(() => expect(pids).toHaveLength(1))
    await vi.waitFor(async () => expect(await backendExists(pids[0])).toBe(false))

    controller.abort()
    await loop.stopped
  })

  it('keeps the loop alive when creating the client throws', async () => {
    let attempts = 0
    const loop = runMaintenanceLoop(controller.signal, {
      createClient: () => {
        attempts += 1
        throw new Error('invalid connection config')
      },
      run: vi.fn(),
      intervalMs: 5,
    })

    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2))
    expect(console.error).toHaveBeenCalledWith(
      '[maintenance] run failed unexpectedly:',
      expect.objectContaining({ message: 'invalid connection config' })
    )

    controller.abort()
    await loop.stopped
  })
})
