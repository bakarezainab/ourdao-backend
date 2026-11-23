/**
 * Prometheus metrics for operational observability (issues #528, #529).
 *
 * Metrics are registered here and incremented from their respective modules.
 * The API process exposes them at GET /metrics; the worker process currently
 * does not serve its own /metrics endpoint (noted in issue #528 as future work).
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client'

// Single registry for all metrics
export const register = new Registry()

/**
 * Alias for `register`. Code that was written against an older name
 * (`metricsRegistry`) imports this; both names refer to the same instance.
 */
export const metricsRegistry = register

// ── SSE connection metrics (issue #274) ──

/** Gauge: currently open SSE connections. */
export const sseConnectionsGauge = new Gauge({
  name: 'ourdao_sse_connections',
  help: 'Currently open SSE connections',
  registers: [register],
})

/** Counter: SSE connections opened, ever. */
export const sseConnectionsTotal = new Counter({
  name: 'ourdao_sse_connections_total',
  help: 'Total SSE connections opened',
  registers: [register],
})

/** Counter: SSE messages written, labeled by event_type. */
export const sseMessagesTotal = new Counter({
  name: 'ourdao_sse_messages_total',
  help: 'Total SSE messages sent, by event type',
  labelNames: ['event_type'],
  registers: [register],
})

/**
 * Issue #528: Count of RPC rate-limit (429) retries, labeled by operation.
 *
 * Incremented by src/stellar/rpc.ts's withRateLimitRetry on each retry attempt.
 * An operator can alert on this to detect chronic rate-limiting (worth switching
 * providers or upgrading to a paid tier).
 */
export const rpcRateLimitRetriesCounter = new Counter({
  name: 'ourdao_rpc_rate_limit_retries_total',
  help: 'Total number of RPC rate-limit (429) retries',
  labelNames: ['operation'],
  registers: [register],
})

/**
 * Issue #529: Count of replay outcomes, labeled by the ReplayOutcome value.
 *
 * Incremented by src/indexer/replay.ts's replayFailedEvent at the end of each
 * replay attempt. Outcomes: 'replayed', 'already_resolved', 'still_failing'.
 */
export const replayOutcomesCounter = new Counter({
  name: 'ourdao_replay_outcomes_total',
  help: 'Count of replay outcomes for quarantined events',
  labelNames: ['outcome'],
  registers: [register],
})

/**
 * Issue #529: Count of reindex runs.
 *
 * Incremented by src/indexer/reindex.ts's reindexFromEventLog at the end of
 * each successful reindex operation.
 */
export const reindexRunsCounter = new Counter({
  name: 'ourdao_reindex_runs_total',
  help: 'Total number of reindex operations completed',
  registers: [register],
})

/**
 * Issue #529: Histogram of reindex duration in seconds.
 *
 * Observed by src/indexer/reindex.ts's reindexFromEventLog to track how long
 * a full rebuild takes (useful for capacity planning and detecting regressions).
 */
export const reindexDurationHistogram = new Histogram({
  name: 'ourdao_reindex_duration_seconds',
  help: 'Duration of reindex operations in seconds',
  buckets: [1, 5, 10, 30, 60, 120, 300, 600], // 1s to 10min
  registers: [register],
})
