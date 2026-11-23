/**
 * Issue #510 — Measure contract cardinality in the `events` table.
 *
 * Reports:
 *   - Total event count: COUNT(*)
 *   - Distinct contracts: COUNT(DISTINCT contract_id)
 *   - Per-contract breakdown of event volume
 *   - Size of the events table vs events_contract_id_idx index
 *
 * Usage:
 *   DATABASE_URL=... npm run measure:contract-cardinality
 *   or:
 *   npx tsx scripts/measure-contract-cardinality.ts
 */
import { pool } from '../src/db/index.js'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

async function main(): Promise<void> {
  console.log('=== Measuring contract_id cardinality and events storage ===\n')

  // 1. Cardinality query
  const cardResult = await pool.query<{
    total_events: string
    distinct_contracts: string
  }>(`
    SELECT
      count(*)::text AS total_events,
      count(DISTINCT contract_id)::text AS distinct_contracts
    FROM events
  `)
  const totalEvents = Number(cardResult.rows[0]?.total_events ?? 0)
  const distinctContracts = Number(cardResult.rows[0]?.distinct_contracts ?? 0)

  console.log(`Total events: ${totalEvents.toLocaleString()}`)
  console.log(`Distinct contract_id count: ${distinctContracts.toLocaleString()}`)

  // 2. Breakdown per contract
  if (totalEvents > 0) {
    const breakdown = await pool.query<{
      contract_id: string
      count: string
      pct: string
    }>(`
      SELECT
        contract_id,
        count(*)::text AS count,
        round(100.0 * count(*) / sum(count(*)) over (), 2)::text AS pct
      FROM events
      GROUP BY contract_id
      ORDER BY count(*) DESC
    `)
    console.log('\nContract breakdown:')
    for (const row of breakdown.rows) {
      console.log(`  - ${row.contract_id}: ${Number(row.count).toLocaleString()} events (${row.pct}%)`)
    }
  }

  // 3. Relation and index size measurements
  const sizeResult = await pool.query<{
    table_bytes: number
    index_bytes: number
    total_bytes: number
  }>(`
    SELECT
      pg_relation_size('events') AS table_bytes,
      COALESCE(pg_relation_size('events_contract_id_idx'::regclass), 0) AS index_bytes,
      pg_total_relation_size('events') AS total_bytes
  `).catch(() => ({ rows: [] }))

  if (sizeResult.rows.length > 0) {
    const { table_bytes, index_bytes, total_bytes } = sizeResult.rows[0]!
    console.log('\nStorage measurements:')
    console.log(`  - events heap: ${formatBytes(table_bytes)}`)
    console.log(`  - events_contract_id_idx: ${formatBytes(index_bytes)}`)
    console.log(`  - events total relation (heap + indexes + toast): ${formatBytes(total_bytes)}`)
    if (total_bytes > 0) {
      const idxPct = ((index_bytes / total_bytes) * 100).toFixed(2)
      console.log(`  - events_contract_id_idx overhead: ${idxPct}% of total events storage`)
    }
  }

  console.log('\nEvaluation criteria:')
  console.log('  - If distinct_contracts == 1 and deployment is strictly single-contract (CONTRACT_ID only),')
  console.log('    the index provides negligible selectivity on contract_id alone.')
  console.log('  - If distinct_contracts > 1 (multi-contract deployment via CONTRACT_IDS), the index prevents')
  console.log('    full table scans on queries filtered by ?contract= (e.g. /api/events, /api/admin/log).')
  console.log('  - Retaining the index incurs minimal storage overhead (~40 bytes/row, ~5% of table size).')

  await pool.end()
}

main().catch((err) => {
  console.error('[measure-contract-cardinality] failed:', err)
  process.exit(1)
})
