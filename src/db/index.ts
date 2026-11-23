import { Client, Pool, types as pgTypes, type PoolClient, type QueryResultRow } from 'pg'
import { config } from '../config.js'
import { dbPoolIdleClientErrorsTotal } from '../api/metrics.js'

// pg returns Postgres BIGINT (OID 20) as a JS string by default — the safe
// choice, since a BIGINT can exceed Number.MAX_SAFE_INTEGER and would
// silently truncate on conversion. Every BIGINT column in *this* schema is a
// ledger sequence number, comfortably inside that range and typed `number`
// in src/types.ts, so we parse it as one.
//
// Issue #15: this parser is scoped to this pool's `types` config, NOT
// installed on the process-wide `pg.types` registry — a global
// `setTypeParser(20, …)` reached every pg consumer in the process and turned
// "add a BIGINT column" into a silent-truncation trap. Kept here so the
// assumption is visible and local. The column-type rule it depends on —
// on-chain i128 amounts are NUMERIC(40,0) and come back as decimal strings,
// never BIGINT — is documented in the README ("Database schema") and
// CONTRIBUTING.md.
const BIGINT_OID = 20
const parseBigIntAsNumber = (value: string): number => Number.parseInt(value, 10)

const scopedGetTypeParser = ((oid: number, format?: 'text' | 'binary') =>
  oid === BIGINT_OID
    ? parseBigIntAsNumber
    : format === 'binary'
      ? pgTypes.getTypeParser(oid, 'binary')
      : pgTypes.getTypeParser(oid, 'text')
) as unknown as typeof pgTypes.getTypeParser

// A single shared pool. pg picks up PG* env vars automatically; a
// DATABASE_URL connection string takes precedence when provided.
const connectionString =
  config.db.connectionString ||
  process.env.DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  (process.env.NODE_ENV === 'test' || process.env.VITEST ? 'postgres://ourdao:ourdao@localhost:5432/ourdao_test' : undefined)

export const pool = new Pool({
  ...(connectionString ? { connectionString } : {}),
  types: { getTypeParser: scopedGetTypeParser },
  // Issue #152: explicit and documented rather than relying on
  // node-postgres's implicit default (also 10, coincidentally). This pool no
  // longer needs to size for concurrent SSE clients — /api/stream shares one
  // long-lived listener connection for the whole process (src/api/stream.ts)
  // instead of checking one out per client — so DB_POOL_MAX only has to cover
  // ordinary request concurrency (queries, transactions, the nonce store).
  max: config.db.poolMax,
  // Issue #167: without this, a caller waiting on `pool.connect()`/
  // `pool.query()` when every connection is checked out (or Postgres is
  // unreachable at the TCP level) waits forever — there was no bound at all.
  // `/ready` also races its own check against READY_CHECK_TIMEOUT_MS as a
  // second, tighter guard, but every other route sharing this pool benefits
  // from this floor too.
  connectionTimeoutMillis: config.db.connectionTimeoutMs,
  // Issue #167: server-side per-statement timeout applied on every
  // connection this pool opens, so a query that hangs after a connection was
  // successfully established (a stuck lock, a database mid-failover) is
  // killed by Postgres rather than left running indefinitely.
  statement_timeout: config.db.statementTimeoutMs,
  // Issue #196: evict idle connections after a configurable time rather than
  // relying on pg's implicit 30s.
  idleTimeoutMillis: config.db.idleTimeoutMs,
  // Issue #196: distinguishes this process's connections (api / worker) in
  // pg_stat_activity.
  application_name: config.db.applicationName,
})

pool.on('error', (err) => {
  // Background idle-client errors shouldn't crash the process.
  console.error('[db] unexpected idle client error:', err.message)
  dbPoolIdleClientErrorsTotal.inc()
})

/**
 * A standalone connection, entirely outside the pool and its `max` (issue
 * #152's code review): used for the `/api/stream` shared LISTEN connection,
 * which is checked out once and held for the life of the process. Taking it
 * from `pool.connect()` instead would silently consume one of `DB_POOL_MAX`'s
 * slots — the opposite of this pool being "sized for ordinary request
 * concurrency only" — and would make `pool.end()` hang forever on shutdown,
 * since pg-pool's `end()` only resolves once every checked-out client has
 * been released, which a permanently-held listener connection never is.
 */
export function createDedicatedClient(): Client {
  return new Client({
    ...(connectionString ? { connectionString } : {}),
    types: { getTypeParser: scopedGetTypeParser },
    application_name: `${config.db.applicationName}-listener`,
  })
}

/**
 * Issue #584: a Postgres advisory lock distinct from REINDEX_LOCK_KEY
 * (src/indexer/reindex.ts, held only for the duration of a reindex/replay
 * fold, not ordinary polling) and MIGRATION_LOCK_KEY (src/db/migrate.ts,
 * released as soon as migrate() returns) — this one is acquired once at
 * worker startup and held on its own dedicated connection for the entire
 * lifetime of the poll loop, so a container scheduler briefly running two
 * worker instances during a handoff can't have both of them fold events
 * concurrently (docs/DEPLOYMENT.md: the worker "must be a singleton").
 *
 * Scoped to the current schema (the second `hashtext(...)` key), matching
 * every other advisory lock in this codebase, so parallel test workers —
 * each given their own schema by test/setup.ts — don't block each other.
 *
 * `pg_try_advisory_lock` (non-blocking) rather than the blocking variant:
 * a worker that can't acquire it should refuse to start loudly, not hang.
 * It's a *session*-level lock (not `_xact_`), held on a connection that is
 * never returned to `pool` and never closed until `release()` is called —
 * exactly the same "standalone connection outside the pool, held for the
 * life of the process" shape as the `/api/stream` listener connection above.
 * Postgres releases a session-level advisory lock automatically when the
 * holding connection closes, so a worker that crashes without calling
 * `release()` frees the lock as soon as Postgres notices the dropped
 * connection — no cleanup code has to run for that case.
 */
export const WORKER_LEADER_LOCK_KEY = 0x0d40_0002

/** The two primitives `acquireWorkerLeaderLock` composes, exported
 *  separately so a test can drive a raw connection directly — in
 *  particular to simulate a crashed holder by dropping its connection
 *  *without* going through the clean `release()` path below, which always
 *  sends an explicit unlock first and so can't exercise Postgres's own
 *  "session ended, release its locks" behavior. */
export async function tryAcquireLeaderLock(client: Client): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock($1, hashtext(coalesce(current_schema(), ''))) AS locked`,
    [WORKER_LEADER_LOCK_KEY]
  )
  return result.rows[0]?.locked ?? false
}

export async function releaseLeaderLock(client: Client): Promise<void> {
  await client.query(
    `SELECT pg_advisory_unlock($1, hashtext(coalesce(current_schema(), '')))`,
    [WORKER_LEADER_LOCK_KEY]
  )
}

export interface WorkerLeaderLock {
  /** Releases the lock and closes its dedicated connection. Safe to call
   *  more than once — only the first call does anything. */
  release(): Promise<void>
}

/** Throws with an actionable message if another worker already holds the
 *  lock (in this schema) — see the module doc comment above. */
export async function acquireWorkerLeaderLock(): Promise<WorkerLeaderLock> {
  const client = createDedicatedClient()
  await client.connect()

  let acquired: boolean
  try {
    acquired = await tryAcquireLeaderLock(client)
  } catch (err) {
    await client.end().catch(() => {})
    throw err
  }

  if (!acquired) {
    await client.end().catch(() => {})
    throw new Error(
      'Could not acquire the worker leader-election lock — another worker instance appears to already hold it ' +
        'against this database/schema. Refusing to start a second indexer: running two concurrently can silently ' +
        'corrupt derived state (vote tallies, contribution balances, and notification inserts are non-idempotent ' +
        'increments with no database-level guard against being applied twice). Postgres releases a crashed ' +
        "worker's lock automatically once it notices that connection is gone — if the other worker is not actually " +
        'running, retry shortly. See docs/DEPLOYMENT.md "Leader election".'
    )
  }

  let released = false
  return {
    async release(): Promise<void> {
      if (released) return
      released = true
      try {
        await releaseLeaderLock(client)
      } catch {
        // The connection may already be gone (e.g. the DB was unreachable) —
        // nothing to explicitly unlock in that case; Postgres never held it.
      } finally {
        await client.end().catch(() => {})
      }
    },
  }
}

/**
 * Issue #196: lift `statement_timeout` for the current transaction only, for
 * the deliberately long-running paths (reindex) that the pool-wide default
 * would otherwise kill. Must be called inside a `BEGIN` — `SET LOCAL` reverts
 * automatically at COMMIT/ROLLBACK, so the connection returns to the pool
 * with the normal limit.
 */
export async function exemptTransactionFromStatementTimeout(client: PoolClient, applicationName?: string): Promise<void> {
  await client.query('SET LOCAL statement_timeout = 0')
  if (applicationName) await client.query(`SELECT set_config('application_name', $1, true)`, [applicationName])
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  const res = await pool.query<T>(text, params as unknown[])
  return res.rows
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/** Run a set of statements inside a transaction. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      console.error('[db] transaction rollback failed:', rollbackErr)
      if (err instanceof Error) {
        if (!('cause' in err) || !err.cause) {
          try {
            Object.defineProperty(err, 'cause', {
              value: rollbackErr,
              configurable: true,
              writable: true,
              enumerable: false,
            })
          } catch {
            // ignore if object cannot be extended
          }
        }
      }
    }
    throw err
  } finally {
    client.release()
  }
}
