#!/usr/bin/env tsx
/**
 * API latency benchmark for key endpoints (issue #220).
 * 
 * Measures p50 and p95 latency for endpoints the frontend polls:
 * - GET /api/stats
 * - GET /api/loans
 * - GET /api/proposals/loan
 * - GET /api/members/:address/summary
 * 
 * Runs against a database seeded to realistic scale (not empty), recording
 * baseline metrics to validate caching and indexing decisions.
 */

import { performance } from 'perf_hooks'
import { buildServer } from '../src/api/server.js'
import { pool, query } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'

// Test parameters
const WARMUP_REQUESTS = 10
const BENCHMARK_REQUESTS = 100
const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' // Example

interface BenchmarkResult {
  endpoint: string
  requests: number
  p50: number
  p95: number
  min: number
  max: number
  mean: number
}

// Scale docs/API-LATENCY-BASELINE.md describes: 100+ members, 50+ loan
// proposals, 30+ loans, plus treasury proposals and interest distributions.
export const SEED_SCALE = {
  members: 120,
  loanProposals: 60,
  loans: 40,
  treasuryProposals: 20,
  interestDistributions: 30,
} as const

// Synthetic, StrKey-shaped (G + 55 base32 chars) member address for row `i`.
const SEED_ADDRESS_SQL = `'GBENCH' || translate(lpad(i::text, 50, '0'), '0123456789', 'ABCDEFGHIJ')`

/**
 * Creates or tops up the derived tables the benchmarked endpoints read to
 * SEED_SCALE. Idempotent: rows are keyed on fixed ids/addresses and inserted
 * with ON CONFLICT DO NOTHING, so a rerun (or a database that already has
 * real data) only fills in what is missing. TEST_ADDRESS is seeded as a
 * member so the summary benchmark measures a real 200, not a 404.
 */
export async function seedDatabase(): Promise<void> {
  console.log('[bench] Seeding database to realistic scale (top-up, idempotent)...')

  await query(
    `INSERT INTO members (address, joined_ledger, contribution, stake)
     VALUES ($1, 1, 1000000000, 500000000)
     ON CONFLICT (address) DO NOTHING`,
    [TEST_ADDRESS]
  )
  await query(
    `INSERT INTO members (address, joined_ledger, contribution, stake, has_active_loan)
     SELECT ${SEED_ADDRESS_SQL}, i, 1000000000 + i * 1000, 500000000, i <= $2
       FROM generate_series(1, $1::int) AS i
     ON CONFLICT (address) DO NOTHING`,
    [SEED_SCALE.members, SEED_SCALE.loans]
  )
  await query(
    `INSERT INTO loan_proposals (id, borrower, amount, total_repayment, status, votes_for, votes_against, voter_count, created_ledger)
     SELECT 900000 + i, ${SEED_ADDRESS_SQL}, 10000000 * i, 11000000 * i,
            (ARRAY['pending', 'approved', 'rejected', 'cancelled'])[1 + i % 4], i * 3, i, 4, 1000 + i
       FROM generate_series(1, $1::int) AS i
     ON CONFLICT (id) DO NOTHING`,
    [SEED_SCALE.loanProposals]
  )
  await query(
    `INSERT INTO loans (id, borrower, amount, outstanding, total_repayment, status, approved_ledger, due_time)
     SELECT 900000 + i, ${SEED_ADDRESS_SQL}, 10000000 * i,
            CASE WHEN i % 5 = 0 THEN 0 ELSE 11000000 * i END, 11000000 * i,
            CASE WHEN i % 5 = 0 THEN 'repaid' ELSE 'active' END, 2000 + i, now() + i * interval '1 day'
       FROM generate_series(1, $1::int) AS i
     ON CONFLICT (id) DO NOTHING`,
    [SEED_SCALE.loans]
  )
  await query(
    `INSERT INTO treasury_proposals (id, amount, destination, status, votes_for, votes_against, voter_count, created_ledger)
     SELECT 900000 + i, 5000000 * i, ${SEED_ADDRESS_SQL},
            (ARRAY['pending', 'executed', 'rejected'])[1 + i % 3], i * 2, i, 3, 3000 + i
       FROM generate_series(1, $1::int) AS i
     ON CONFLICT (id) DO NOTHING`,
    [SEED_SCALE.treasuryProposals]
  )
  await query(
    `INSERT INTO interest_distributions (event_id, ledger, amount, active_members)
     SELECT 'bench-interest-' || i, 4000 + i, 100000 * i, $2::int
       FROM generate_series(1, $1::int) AS i
     ON CONFLICT (event_id) DO NOTHING`,
    [SEED_SCALE.interestDistributions, SEED_SCALE.members]
  )
}

async function benchmarkEndpoint(
  endpoint: string,
  makeRequest: () => Promise<unknown>
): Promise<BenchmarkResult> {
  const latencies: number[] = []
  
  // Warmup
  console.log(`[bench] Warming up ${endpoint}...`)
  for (let i = 0; i < WARMUP_REQUESTS; i++) {
    await makeRequest()
  }
  
  // Actual benchmark
  console.log(`[bench] Benchmarking ${endpoint} (${BENCHMARK_REQUESTS} requests)...`)
  for (let i = 0; i < BENCHMARK_REQUESTS; i++) {
    const start = performance.now()
    await makeRequest()
    const end = performance.now()
    latencies.push(end - start)
  }
  
  // Calculate percentiles
  latencies.sort((a, b) => a - b)
  const p50Index = Math.floor(latencies.length * 0.5)
  const p95Index = Math.floor(latencies.length * 0.95)
  
  const result: BenchmarkResult = {
    endpoint,
    requests: latencies.length,
    p50: latencies[p50Index]!,
    p95: latencies[p95Index]!,
    min: latencies[0]!,
    max: latencies[latencies.length - 1]!,
    mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
  }
  
  return result
}

function printResults(results: BenchmarkResult[]) {
  console.log('\n' + '='.repeat(80))
  console.log('API Latency Benchmark Results')
  console.log('='.repeat(80))
  console.log()
  
  console.log('| Endpoint | p50 (ms) | p95 (ms) | Min (ms) | Max (ms) | Mean (ms) |')
  console.log('|----------|----------|----------|----------|----------|-----------|')
  
  for (const r of results) {
    console.log(
      `| ${r.endpoint.padEnd(37)} | ${r.p50.toFixed(2).padStart(8)} | ${r.p95.toFixed(2).padStart(8)} | ${r.min.toFixed(2).padStart(8)} | ${r.max.toFixed(2).padStart(8)} | ${r.mean.toFixed(2).padStart(9)} |`
    )
  }
  
  console.log()
  console.log(`Benchmark completed with ${BENCHMARK_REQUESTS} requests per endpoint`)
  console.log()
}

async function main() {
  console.log('[bench] API Latency Benchmark')
  console.log('[bench] Issue #220: Baseline performance measurement\n')
  
  // Apply schema
  await migrate()
  
  // Seed database if needed
  await seedDatabase()
  
  // Build server
  const app = await buildServer({ logger: { level: 'silent' } })
  await app.listen({ port: 0, host: '127.0.0.1' })
  
  const results: BenchmarkResult[] = []
  
  try {
    // Benchmark GET /api/stats
    results.push(
      await benchmarkEndpoint('GET /api/stats', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/stats' })
        if (response.statusCode !== 200) throw new Error(`Stats returned ${response.statusCode}`)
        return response.json()
      })
    )
    
    // Benchmark GET /api/loans
    results.push(
      await benchmarkEndpoint('GET /api/loans', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/loans' })
        if (response.statusCode !== 200) throw new Error(`Loans returned ${response.statusCode}`)
        return response.json()
      })
    )
    
    // Benchmark GET /api/proposals/loan
    results.push(
      await benchmarkEndpoint('GET /api/proposals/loan', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/proposals/loan' })
        if (response.statusCode !== 200) throw new Error(`Loan proposals returned ${response.statusCode}`)
        return response.json()
      })
    )
    
    // Benchmark GET /api/members/:address/summary
    results.push(
      await benchmarkEndpoint(`GET /api/members/${TEST_ADDRESS}/summary`, async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/members/${TEST_ADDRESS}/summary`,
        })
        // 404 is acceptable if the test address doesn't exist - we're measuring query time
        if (response.statusCode !== 200 && response.statusCode !== 404) {
          throw new Error(`Member summary returned ${response.statusCode}`)
        }
        return response.json()
      })
    )
    
    printResults(results)
  } finally {
    await app.close()
    await pool.end()
  }
}

// Guarded so importing seedDatabase (as test/bench-api-latency-seed.test.ts
// does) never starts the benchmark.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[bench] fatal:', err)
    process.exit(1)
  })
}
