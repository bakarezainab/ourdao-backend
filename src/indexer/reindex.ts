import type { PoolClient } from 'pg'
import { pool } from '../db/index.js'
import { applyEvent } from './handlers.js'
import { namedFields, type DecodedEvent } from '../stellar/events.js'
import { DERIVED_TABLES, resetDaoTotals } from './derived-tables.js'
import { reindexRunsCounter, reindexDurationHistogram } from '../api/metrics.js'
import { logger } from '../lib/logger.js'

interface EventLogRow {
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
 * Rebuild every derived table from the raw `events` log (issue #23).
 *
 * The incremental fold the indexer runs and a full rebuild from the log must
 * produce byte-identical derived state — that property is what makes the raw
 * log authoritative and makes re-indexing a real recovery mechanism: for a
 * detected ledger discontinuity, and for the historical-data bugs tracked in
 * other issues in this repo (rejoin double-counting, missing default
 * penalties, unweighted tallies) which this command repairs in one pass.
 *
 * Runs in a single transaction — the whole rebuild lands or none of it does.
 *
 * Issue #529: Increments ourdao_reindex_runs_total counter and observes
 * ourdao_reindex_duration_seconds histogram on completion.
 */
export async function reindexFromEventLog(): Promise<{ events: number }> {
  const startTime = Date.now()
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`TRUNCATE ${DERIVED_TABLES.join(', ')} RESTART IDENTITY`)
    await resetDaoTotals(client)

    const { rows } = await client.query<EventLogRow>(
      `SELECT id, ledger, closed_at, contract_id, symbol, topics, data, tx_hash
         FROM events ORDER BY ledger ASC, id ASC`
    )

    // Issue #531: report progress as structured JSON, one line per 10% (and
    // the final event). `msg` keeps the human-readable text an operator
    // watching a terminal saw before; the fields make it queryable.
    const total = rows.length
    const progressEvery = Math.max(1, Math.ceil(total / 10))

    for (const [index, row] of rows.entries()) {
      const data = Array.isArray(row.data) ? (row.data as unknown[]) : [row.data]
      const ev: DecodedEvent = {
        id: row.id,
        ledger: row.ledger,
        closedAt:
          row.closed_at instanceof Date ? row.closed_at.toISOString() : String(row.closed_at),
        contractId: row.contract_id,
        txHash: row.tx_hash,
        symbol: row.symbol,
        topics: Array.isArray(row.topics) ? (row.topics as unknown[]) : [],
        data,
        fields: namedFields(row.symbol, data),
      }
      await applyEvent(client, ev)

      const processed = index + 1
      if (processed % progressEvery === 0 || processed === total) {
        const elapsedSec = (Date.now() - startTime) / 1000
        const ratePerSec = elapsedSec > 0 ? processed / elapsedSec : 0
        const etaSec = ratePerSec > 0 ? Math.ceil((total - processed) / ratePerSec) : 0
        const pct = total > 0 ? (processed / total) * 100 : 100
        logger.info(
          `[reindex] progress: ${processed}/${total} event(s) (${pct.toFixed(2)}%) — ` +
            `${ratePerSec.toFixed(1)} events/s, eta ${etaSec}s`,
          { processed, total, pct, ratePerSec, etaSec }
        )
      }
    }

    await client.query('COMMIT')
    
    // Issue #529: record metrics on successful completion
    const durationSeconds = (Date.now() - startTime) / 1000
    reindexRunsCounter.inc()
    reindexDurationHistogram.observe(durationSeconds)
    
    return { events: rows.length }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// `npm run reindex`
if (import.meta.url === `file://${process.argv[1]}`) {
  reindexFromEventLog()
    .then(({ events }) => {
      logger.info(`[reindex] rebuilt derived tables from ${events} event(s)`, { events })
      return pool.end()
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[reindex] failed: ${message}`, { error: message })
      process.exit(1)
    })
}
/* v8 ignore stop */
