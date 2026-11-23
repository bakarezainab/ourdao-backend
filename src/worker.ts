import './worker-role.js'
import { initTelemetry, shutdownTelemetry } from './telemetry.js'
import { migrate } from './db/migrate.js'
import { pool } from './db/index.js'
import { runIndexer, stopIndexer } from './indexer/poller.js'
import { startWorkerDiagnosticsServer } from './indexer/worker-diagnostics.js'
import { runMaintenanceLoop } from './maintenance-loop.js'
import { closeRedis } from './cache/redis.js'

const SHUTDOWN_TIMEOUT_MS = 10_000

async function main(): Promise<void> {
  // Issue #288: registered before anything else runs, matching OpenTelemetry's
  // own recommended Node.js bootstrap ordering — a no-op when OTEL_ENABLED
  // is unset (the default), see src/telemetry.ts.
  initTelemetry()
  await migrate()

  const maintenanceAbort = new AbortController()
  const maintenance = runMaintenanceLoop(maintenanceAbort.signal)

  // Issue #503: served from this process because cursorWriteFailures is
  // process-local. A bind failure is logged and swallowed by the helper; it
  // must never stop the singleton indexer.
  const diagnostics = await startWorkerDiagnosticsServer()

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[indexer] received ${signal} — waiting for current page to complete`)

    maintenanceAbort.abort()

    // Issue #261: Wait for the indexer loop to finish its current page and exit,
    // bounded so a wedged RPC call can't hang shutdown forever (issue #47).
    const stopPromise = stopIndexer()
    let timedOut = false
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true
        resolve()
      }, SHUTDOWN_TIMEOUT_MS)
    })
    await Promise.race([stopPromise, timeout])

    if (timedOut) {
      // stopIndexer() never resolved within the budget — closing the pool
      // now risks doing so mid-transaction (issue #122). The backoff sleep
      // is abort-aware (issue #121), so runIndexer's loop should exit almost
      // immediately once signaled; hitting this budget instead means
      // something else is stuck (a wedged RPC call, a long-running query)
      // and is worth investigating, not a normal shutdown path.
      console.error(
        `[indexer] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — closing the pool anyway; ` +
          `the indexer loop may still have been mid-transaction`
      )
    }

    if (diagnostics) await diagnostics.close()

    // Issue #261: The maintenance loop only checks its abort signal between runs (or
    // right after connecting), so it isn't raced here the way the indexer
    // is above — a maintenance run in flight when shutdown starts is a plain
    // VACUUM/DELETE using its own dedicated connection, entirely independent
    // of `pool`, and finishes (or fails) on its own without blocking this.
    // Wait for it to complete before closing the pool.
    await maintenance.stopped

    console.log('[indexer] closing database pool')
    await closeRedis()
    await pool.end()
    await shutdownTelemetry()
    console.log('[indexer] shutdown complete')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await runIndexer()
}

main().catch((err) => {
  console.error('[indexer] fatal:', err)
  process.exit(1)
})
