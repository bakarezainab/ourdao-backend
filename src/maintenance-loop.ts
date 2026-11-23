import type { Client } from 'pg'
import { createDedicatedClient } from './db/index.js'
import { config } from './config.js'
import { runMaintenance, logMaintenanceResult } from './db/maintenance.js'

export interface MaintenanceLoopDeps {
  createClient: () => Client
  run: (client: Client) => ReturnType<typeof runMaintenance>
  intervalMs: number
}

// Issue #279: periodic VACUUM ANALYZE + expired-auth_nonces sweep, run
// alongside the indexer loop on its own abort-aware timer — a self-
// rescheduling setTimeout loop (matching the style already used by the
// indexer's own poll loop in src/indexer/poller.ts), so a maintenance run
// that takes a while never overlaps with the next scheduled one, and the
// loop stops promptly on shutdown rather than leaving a dangling timer.
//
// Extracted from src/worker.ts (issue #549) so the dedicated client's
// connection lifecycle can be tested without booting the worker process.
export function runMaintenanceLoop(
  signal: AbortSignal,
  deps: Partial<MaintenanceLoopDeps> = {}
): { stopped: Promise<void> } {
  const createClient = deps.createClient ?? createDedicatedClient
  const run = deps.run ?? runMaintenance
  const intervalMs = deps.intervalMs ?? config.maintenance.intervalMs

  let resolveStopped: () => void
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })

  async function tick(): Promise<void> {
    if (signal.aborted) {
      resolveStopped()
      return
    }

    // Issue #549: the client is created inside the try so that every exit
    // path — a throwing constructor, a failed connect(), or a failed run —
    // is logged, reaches the cleanup below, and still reschedules the next
    // run. Previously a throw from createDedicatedClient() escaped tick()
    // as an unhandled rejection and silently ended the maintenance loop.
    let client: Client | undefined
    try {
      client = createClient()
      await client.connect()
      const result = await run(client)
      logMaintenanceResult(result)
    } catch (err) {
      // A maintenance run failing outright (e.g. can't even connect) must
      // never crash the worker or block the indexer (issue #279) — log and
      // wait for the next scheduled run.
      console.error('[maintenance] run failed unexpectedly:', err)
    } finally {
      try {
        await client?.end()
      } catch {
        // Ignore — the connection may already be gone.
      }
    }

    if (signal.aborted) {
      resolveStopped()
      return
    }

    const timer = setTimeout(() => void tick(), intervalMs)
    // Don't hold the process open on this timer alone — mirrors the
    // indexer's own backoff-sleep timers (issue #121).
    if (timer.unref) timer.unref()
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolveStopped()
      },
      { once: true }
    )
  }

  void tick()
  return { stopped }
}
