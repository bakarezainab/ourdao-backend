import { createServer, type Server } from 'node:http'
import { config } from '../config.js'
import { configuredContracts } from '../api/contract-health.js'
import { getCursorWriteFailure, getCursorWriteFailures } from './poller.js'

/**
 * Issue #503: `cursorWriteFailures` lives in the worker's memory, not in
 * Postgres and not in the API process. This helper is deliberately pure so it
 * can be tested without starting an indexer, and so the HTTP surface cannot
 * accidentally add fields the tracker does not provide (`error` and `at` are
 * the only diagnostic metadata the map stores).
 */
export interface CursorWriteFailureDiagnostic {
  failed: boolean
  at?: number
  error?: string
}

export interface CursorWriteFailureSnapshot {
  process: 'worker'
  cursorWriteFailures: Record<string, CursorWriteFailureDiagnostic>
}

export function buildCursorWriteFailureDiagnostic(
  contractIds: string[] = configuredContracts()
): CursorWriteFailureSnapshot {
  const snapshot = getCursorWriteFailures()
  // Include every configured contract (with failed: false when there is no
  // recorded failure) plus any snapshot id no longer in the configured set,
  // so a removed contract's last failure is not silently hidden.
  const ids = new Set([...contractIds, ...snapshot.keys()])
  const failures: Record<string, CursorWriteFailureDiagnostic> = {}
  for (const id of ids) {
    const failure = getCursorWriteFailure(id) ?? snapshot.get(id) ?? null
    failures[id] = failure
      ? { failed: true, at: failure.at, error: failure.error }
      : { failed: false }
  }
  return { process: 'worker', cursorWriteFailures: failures }
}

export interface WorkerDiagnosticsServer {
  /** Bound port (useful when tests pass port 0). */
  port: number
  close(): Promise<void>
}

export interface WorkerDiagnosticsOptions {
  host?: string
  port?: number
}

/**
 * A tiny loopback-only HTTP listener in the worker process. Do not move this
 * to src/index.ts: the API process has a different `cursorWriteFailures` map
 * (an empty one) and reporting it as worker state would be misleading.
 *
 * A port conflict must not take down the singleton indexer — the diagnostic
 * simply stays unavailable and a warning is logged.
 */
export async function startWorkerDiagnosticsServer(
  opts: WorkerDiagnosticsOptions = {}
): Promise<WorkerDiagnosticsServer | null> {
  const host = opts.host ?? config.workerDiagnostics.host
  const port = opts.port ?? config.workerDiagnostics.port
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'GET' || (path !== '/ready' && path !== '/diagnostics/cursor-writes')) {
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    try {
      const body = { status: 'ready', ...buildCursorWriteFailureDiagnostic() }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch (err) {
      // Structured, safe failure — never echo exception text.
      console.error('[worker-diagnostics] failed to build diagnostic:', err)
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ status: 'error', error: 'diagnostic unavailable' }))
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error'
    console.warn(
      `[worker-diagnostics] cannot listen on ${host}:${port} (${code}); ` +
        'cursor-write diagnostics are disabled for this worker process.'
    )
    return null
  }
  // Log later failures rather than crashing the indexer on a stray socket error.
  server.on('error', (err) => console.warn('[worker-diagnostics] listener error:', err.message))

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  let closed = false
  return {
    port: boundPort,
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
