import { rpc } from '@stellar/stellar-sdk'
import { SpanStatusCode, type Span } from '@opentelemetry/api'
import { config } from '../config.js'
import { rpcRateLimitRetriesCounter } from '../api/metrics.js'

// Allow http:// for local/standalone RPC while defaulting to secure transport.
// `headers` (issue #284) lets a managed/private RPC provider (QuickNode and
// similar) require an API key or bearer token — only set when
// STELLAR_RPC_HEADERS is non-empty, since passing `headers: {}` is harmless
// but passing `undefined` more clearly reflects "not configured" if the SDK
// ever branches on the option's presence rather than its contents.
const rpcHeaders = config.stellar.rpcHeaders
export const server = new rpc.Server(config.stellar.rpcUrl, {
  allowHttp: config.stellar.rpcUrl.startsWith('http://'),
  ...(Object.keys(rpcHeaders).length > 0 ? { headers: rpcHeaders } : {}),
})

/**
 * Issue #528: Retry wrapper for RPC calls that hit rate limits (429 responses).
 *
 * Retries up to MAX_RETRIES times with exponential backoff when a 429 is detected.
 * Increments the ourdao_rpc_rate_limit_retries_total counter (labeled by operation)
 * on each retry attempt.
 *
 * @param operation - Human-readable operation name for logging and metrics (e.g., 'getLatestLedger', 'getEvents')
 * @param fn - The async function to execute (should be an RPC call)
 * @returns The result of fn
 */
async function withRateLimitRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const MAX_RETRIES = 5
  const BASE_DELAY_MS = 1000

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const isRateLimit =
        err &&
        typeof err === 'object' &&
        'message' in err &&
        typeof err.message === 'string' &&
        (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'))

      if (!isRateLimit || attempt === MAX_RETRIES) {
        // Not a rate limit error, or we've exhausted retries
        throw err
      }

      // Rate limit detected — increment counter and retry with exponential backoff
      rpcRateLimitRetriesCounter.inc({ operation })

      const delay = BASE_DELAY_MS * Math.pow(2, attempt)
      console.warn(
        `[rpc] ${operation} rate-limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      )

      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  // This line is unreachable due to the throw in the loop, but TypeScript needs it
  throw new Error(`[rpc] ${operation} failed after ${MAX_RETRIES} retries`)
}

export async function getLatestLedger(): Promise<number> {
  return withRateLimitRetry('getLatestLedger', async () => {
    const res = await server.getLatestLedger()
    return res.sequence
  })
}

/** Latest-ledger sequence plus its hash (`id`) — used for the coarse rewind
 *  signal in reorg detection (issue #23). */
export async function getLatestLedgerInfo(): Promise<{ sequence: number; hash: string }> {
  return withRateLimitRetry('getLatestLedgerInfo', async () => {
    const res = await server.getLatestLedger()
    return { sequence: res.sequence, hash: res.id }
  })
}
