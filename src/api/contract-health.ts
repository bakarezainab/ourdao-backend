import { config } from '../config.js'
import { query } from '../db/index.js'

/**
 * The configured contract set, regardless of whether it came from CONTRACT_IDS
 * (multi-contract deployments) or the legacy single CONTRACT_ID (issue #506).
 * This is config, not database state: the rows in `indexer_cursor` are the
 * contracts the worker has actually polled, which is a different question.
 */
export function configuredContracts(): string[] {
  if (config.stellar.contractIds.length > 0) return [...config.stellar.contractIds]
  return config.stellar.contractId ? [config.stellar.contractId] : []
}

/** Per-contract cursor/quarantine/reorg state read from Postgres. */
export interface ContractCursorHealth {
  contractId: string
  lastIndexedLedger: number | null
  observedTipLedger: number | null
  ledgersBehind: number | null
  secondsSinceUpdate: number | null
  /** Same rule as /ready: the cursor is stale once idle for longer than INDEXER_STALE_AFTER_MS. */
  stale: boolean
  /** A missing cursor is a cold start, not a stale indexer. */
  status: 'cold_start' | 'stale' | 'ok'
  /** An uncleared row in reorg_halts — the worker halted on purpose. */
  reorgDetected: boolean
  quarantinedEvents: number
  quarantineEscalatedAt: string | null
}

interface ContractCursorRow {
  contract_id: string
  last_ledger: number | null
  observed_tip_ledger: number | null
  updated_at: string | null
  quarantined_events: number
  escalated_at: string | null
  reorg_detected: boolean
}

/**
 * Load cursor health for exactly the configured contracts, including one
 * cold-start entry for each id with no `indexer_cursor` row. Shared by
 * `/api/contracts` and `/api/stats`'s per-contract breakdown so the two can
 * never disagree about ledgersBehind, staleness or halt state.
 *
 * The staleness and halt rules are deliberately the ones `/ready` already
 * uses (same `config.indexer.staleAfterMs`, same `cleared_at IS NULL` check);
 * this does not change `/ready`'s response shape or its worst-row behavior.
 */
export async function loadContractCursorHealth(contractIds: string[]): Promise<Record<string, ContractCursorHealth>> {
  if (contractIds.length === 0) return {}

  const rows = await query<ContractCursorRow>(
    `SELECT ids.contract_id, c.last_ledger, c.observed_tip_ledger, c.updated_at,
            (SELECT count(*)::int FROM failed_events f
              WHERE f.contract_id = ids.contract_id AND f.resolved_at IS NULL) AS quarantined_events,
            q.escalated_at,
            EXISTS (SELECT 1 FROM reorg_halts r
                     WHERE r.contract_id = ids.contract_id AND r.cleared_at IS NULL) AS reorg_detected
       FROM unnest($1::text[]) AS ids(contract_id)
       LEFT JOIN indexer_cursor c ON c.contract_id = ids.contract_id
       LEFT JOIN quarantine_state q ON q.contract_id = ids.contract_id`,
    [contractIds]
  )

  const now = Date.now()
  const health: Record<string, ContractCursorHealth> = {}
  for (const row of rows) {
    const ledgersBehind = row.last_ledger != null && row.observed_tip_ledger != null && row.observed_tip_ledger > row.last_ledger
      ? row.observed_tip_ledger - row.last_ledger
      : null
    const secondsSinceUpdate = row.updated_at == null
      ? null
      : Math.floor((now - new Date(row.updated_at).getTime()) / 1000)
    const coldStart = row.last_ledger == null || row.updated_at == null
    const stale = !coldStart && now - new Date(row.updated_at!).getTime() > config.indexer.staleAfterMs

    health[row.contract_id] = {
      contractId: row.contract_id,
      lastIndexedLedger: row.last_ledger,
      observedTipLedger: row.observed_tip_ledger,
      ledgersBehind,
      secondsSinceUpdate,
      stale,
      status: coldStart ? 'cold_start' : stale ? 'stale' : 'ok',
      reorgDetected: row.reorg_detected,
      quarantinedEvents: row.quarantined_events,
      quarantineEscalatedAt: row.escalated_at == null ? null : new Date(row.escalated_at).toISOString(),
    }
  }
  return health
}
