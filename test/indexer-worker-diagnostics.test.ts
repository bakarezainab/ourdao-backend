import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCursorWriteFailures: vi.fn(),
  getCursorWriteFailure: vi.fn(),
}))

vi.mock('../src/indexer/poller.js', () => ({
  getCursorWriteFailures: mocks.getCursorWriteFailures,
  getCursorWriteFailure: mocks.getCursorWriteFailure,
}))

import { config } from '../src/config.js'
import {
  buildCursorWriteFailureDiagnostic,
  startWorkerDiagnosticsServer,
  type WorkerDiagnosticsServer,
} from '../src/indexer/worker-diagnostics.js'

// Issue #503: cursorWriteFailures lives in the worker's memory. The API
// process cannot honestly report it, so the worker serves its own loopback
// listener. These exercise the pure snapshot builder and the HTTP surface
// without starting an indexer or touching Postgres.
describe('worker cursor-write diagnostics (issue #503)', () => {
  const failure = { error: 'cursor write timeout', at: 1_700_000_000_000 }
  const servers: WorkerDiagnosticsServer[] = []

  beforeEach(() => {
    const snapshot = new Map([
      ['CA', failure],
      ['CGONE', failure],
    ])
    mocks.getCursorWriteFailures.mockReset().mockReturnValue(snapshot)
    mocks.getCursorWriteFailure.mockReset().mockImplementation(
      (id: string) => (id === 'CA' || id === 'CGONE' ? failure : null)
    )
  })

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
    vi.restoreAllMocks()
  })

  it('reports every configured contract plus stale failure ids, with only diagnostic fields', () => {
    const snapshot = buildCursorWriteFailureDiagnostic(['CA', 'CB'])

    expect(snapshot.process).toBe('worker')
    expect(snapshot.cursorWriteFailures).toEqual({
      CA: { failed: true, at: failure.at, error: failure.error },
      CB: { failed: false },
      CGONE: { failed: true, at: failure.at, error: failure.error },
    })
    expect(Object.keys(snapshot.cursorWriteFailures.CA).sort()).toEqual(['at', 'error', 'failed'])
  })

  it('serves the same snapshot over a loopback listener', async () => {
    const originalIds = [...config.stellar.contractIds]
    config.stellar.contractIds.splice(0, config.stellar.contractIds.length, 'CA', 'CB')
    try {
      const server = await startWorkerDiagnosticsServer({ host: '127.0.0.1', port: 0 })
      expect(server).not.toBeNull()
      servers.push(server!)

      const base = `http://127.0.0.1:${server!.port}`
      const res = await fetch(`${base}/diagnostics/cursor-writes`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual({
        status: 'ready',
        process: 'worker',
        cursorWriteFailures: {
          CA: { failed: true, at: failure.at, error: failure.error },
          CB: { failed: false },
          CGONE: { failed: true, at: failure.at, error: failure.error },
        },
      })

      const ready = await fetch(`${base}/ready`)
      expect(ready.status).toBe(200)
      expect((await ready.json()).process).toBe('worker')

      const missing = await fetch(`${base}/not-a-diagnostic`)
      expect(missing.status).toBe(404)
    } finally {
      config.stellar.contractIds.splice(0, config.stellar.contractIds.length, ...originalIds)
    }
  })

  it('does not take down the worker when the diagnostic port is already in use', async () => {
    const first = await startWorkerDiagnosticsServer({ host: '127.0.0.1', port: 0 })
    expect(first).not.toBeNull()
    servers.push(first!)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second = await startWorkerDiagnosticsServer({ host: '127.0.0.1', port: first!.port })

    expect(second).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot listen'))
  })

  it('is started and closed by the worker process', () => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
    expect(source).toContain("import { startWorkerDiagnosticsServer } from './indexer/worker-diagnostics.js'")
    expect(source).toContain('const diagnostics = await startWorkerDiagnosticsServer()')
    expect(source).toContain('if (diagnostics) await diagnostics.close()')
  })
})
