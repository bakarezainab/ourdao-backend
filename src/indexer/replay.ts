/**
 * Replay failed events from quarantine (issue #529 metric instrumentation).
 *
 * This module provides replay functionality for events that failed to fold and
 * were quarantined in the failed_events table. A replay attempts to re-apply
 * the event; if the underlying issue has been fixed, the event folds successfully.
 */
import type { PoolClient } from 'pg'
import { pool } from '../db/index.js'
import { applyEvent } from './handlers.js'
import { namedFields, type DecodedEvent } from '../stellar/events.js'
import { replayOutcomesCounter } from '../api/metrics.js'

/**
 * Issue #529: Replay outcome discriminated union.
 * - 'replayed': event folded successfully this time
 * - 'already_resolved': event_id no longer in failed_events (resolved externally)
 * - 'still_failing': replay attempted but the same error occurred
 */
export type ReplayOutcome = 'replayed' | 'already_resolved' | 'still_failing'

interface FailedEventRow {
  id: number
  event_id: string
  symbol: string
  ledger: number
  error: string
}

interface EventRow {
  id: string
  ledger: number
  closed_at: Date | string
  contract_id: string
  symbol: string
  topics: unknown
  data: unknown
  tx_hash: string | null
}

/**
 * Attempt to replay a single failed event by event_id (issue #529).
 *
 * Queries failed_events for the quarantine record, fetches the raw event from
 * the events table, and re-attempts applyEvent. On success, removes the
 * quarantine record. Increments the ourdao_replay_outcomes_total counter
 * labeled by outcome.
 *
 * @param client - Database client (should be in a transaction)
 * @param eventId - The events.id of the quarantined event
 * @returns ReplayOutcome indicating what happened
 */
export async function replayFailedEvent(
  client: PoolClient,
  eventId: string
): Promise<ReplayOutcome> {
  // Check if this event is still in failed_events
  const failedCheck = await client.query<FailedEventRow>(
    'SELECT id, event_id, symbol, ledger, error FROM failed_events WHERE event_id = $1',
    [eventId]
  )

  if (failedCheck.rows.length === 0) {
    // No longer in failed_events — already resolved
    replayOutcomesCounter.inc({ outcome: 'already_resolved' })
    return 'already_resolved'
  }

  // Fetch the raw event
  const eventResult = await client.query<EventRow>(
    `SELECT id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash
     FROM events WHERE id = $1`,
    [eventId]
  )

  if (eventResult.rows.length === 0) {
    // Event not found in events table — shouldn't happen, but treat as already_resolved
    replayOutcomesCounter.inc({ outcome: 'already_resolved' })
    return 'already_resolved'
  }

  const row = eventResult.rows[0]!
  const data = Array.isArray(row.data) ? (row.data as unknown[]) : [row.data]
  const ev: DecodedEvent = {
    id: row.id,
    ledger: row.ledger,
    closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : String(row.closed_at),
    contractId: row.contract_id,
    txHash: row.tx_hash,
    symbol: row.symbol,
    topics: Array.isArray(row.topics) ? (row.topics as unknown[]) : [],
    data,
    fields: namedFields(row.symbol, data),
  }

  // Attempt to apply the event
  try {
    await applyEvent(client, ev)
    
    // Success! Remove from failed_events
    await client.query('DELETE FROM failed_events WHERE event_id = $1', [eventId])
    
    replayOutcomesCounter.inc({ outcome: 'replayed' })
    return 'replayed'
  } catch {
    // Still failing
    replayOutcomesCounter.inc({ outcome: 'still_failing' })
    return 'still_failing'
  }
}

/**
 * Replay all failed events in failed_events (batch operation).
 *
 * Iterates over all quarantined events and attempts to replay each one.
 * Returns a summary of outcomes.
 */
export async function replayAllFailedEvents(client: PoolClient): Promise<{
  replayed: number
  alreadyResolved: number
  stillFailing: number
}> {
  const { rows } = await client.query<{ event_id: string }>(
    'SELECT DISTINCT event_id FROM failed_events ORDER BY event_id'
  )

  let replayed = 0
  let alreadyResolved = 0
  let stillFailing = 0

  for (const { event_id } of rows) {
    const outcome = await replayFailedEvent(client, event_id)
    if (outcome === 'replayed') replayed++
    else if (outcome === 'already_resolved') alreadyResolved++
    else stillFailing++
  }

  return { replayed, alreadyResolved, stillFailing }
}

const PROGRESS_INTERVAL_MS = 2000

/**
 * Replay all unresolved (resolved_at IS NULL) failed events, one per
 * independent transaction. Logs periodic progress in the same format as
 * reindexFromEventLog so operators get ETA feedback during large backlogs
 * (issue #523).
 *
 * @returns Per-event outcomes in event_id order, omitting already-resolved entries.
 */
export async function replayAllUnresolvedFailedEvents(
  progressIntervalMs = PROGRESS_INTERVAL_MS
): Promise<{ eventId: string; status: ReplayOutcome }[]> {
  const client = await pool.connect()
  let rows: { event_id: string }[]
  try {
    const res = await client.query<{ event_id: string }>(
      `SELECT DISTINCT event_id FROM failed_events WHERE resolved_at IS NULL ORDER BY event_id`
    )
    rows = res.rows
  } finally {
    client.release()
  }

  const total = rows.length
  const results: { eventId: string; status: ReplayOutcome }[] = []
  const startTime = Date.now()
  let lastLogTime = startTime

  for (let i = 0; i < rows.length; i++) {
    const event_id = rows[i]!.event_id
    const txClient = await pool.connect()
    let status: ReplayOutcome
    try {
      await txClient.query('BEGIN')
      status = await replayFailedEvent(txClient, event_id)
      await txClient.query('COMMIT')
    } catch {
      await txClient.query('ROLLBACK').catch(() => {})
      status = 'still_failing'
    } finally {
      txClient.release()
    }

    if (status !== 'already_resolved') {
      results.push({ eventId: event_id, status })
    }

    const processed = i + 1
    const now = Date.now()
    if (total > 0 && (now - lastLogTime >= progressIntervalMs || processed === total)) {
      const elapsedSec = (now - startTime) / 1000
      const rate = elapsedSec > 0 ? (processed / elapsedSec).toFixed(1) : '0'
      const pct = ((processed / total) * 100).toFixed(1)
      const remaining = total - processed
      const etaSec = elapsedSec > 0 && processed > 0 ? Math.round(remaining / (processed / elapsedSec)) : 0
      console.log(
        `[replay] progress: ${processed}/${total} event(s) (${pct}%) — ` +
          `${rate} ev/s, elapsed ${elapsedSec.toFixed(1)}s, ETA ${etaSec}s`
      )
      lastLogTime = now
    }
  }

  return results
}
