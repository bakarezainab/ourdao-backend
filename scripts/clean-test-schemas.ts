#!/usr/bin/env node --import=tsx
/**
 * Clean up orphaned test_worker_* schemas left behind by interrupted test runs
 * (issue #204).
 *
 * Parallel test execution creates one schema per worker (test_worker_1,
 * test_worker_2, etc.). test/setup.ts drops its schema on clean exit, but a
 * killed test run leaves them behind. This script removes all test_worker_*
 * schemas to reclaim space and avoid schema bloat.
 *
 * Do NOT run this while tests are running: it drops every test_worker_*
 * schema, including ones live workers are using, and test/setup.ts only
 * creates a schema when a test file starts — not on demand mid-file.
 *
 * Refuses to run unless DATABASE_URL (what the pool connects to) is unset or
 * equals TEST_DATABASE_URL, so it can't drop schemas in a non-test database.
 */
import { pool } from '../src/db/index.js'

async function main(): Promise<void> {
  const { DATABASE_URL, TEST_DATABASE_URL } = process.env
  if (!TEST_DATABASE_URL || (DATABASE_URL && DATABASE_URL !== TEST_DATABASE_URL)) {
    console.error(
      '[clean-test-schemas] refusing to run: set TEST_DATABASE_URL, and leave DATABASE_URL unset or equal to it'
    )
    process.exitCode = 1
    await pool.end()
    return
  }

  try {
    // Find all test_worker_* schemas (`_` escaped — it is a LIKE wildcard)
    const { rows } = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name LIKE 'test\\_worker\\_%'
       ORDER BY schema_name`
    )

    if (rows.length === 0) {
      console.log('No orphaned test schemas found.')
      return
    }

    console.log(`Found ${rows.length} test schema(s):`, rows.map(r => r.schema_name).join(', '))

    for (const { schema_name } of rows) {
      console.log(`Dropping ${schema_name}...`)
      await pool.query(`DROP SCHEMA IF EXISTS "${schema_name}" CASCADE`)
    }

    console.log(`✓ Cleaned up ${rows.length} test schema(s)`)
  } catch (err) {
    console.error('[clean-test-schemas] failed:', err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[clean-test-schemas] fatal:', err)
  process.exit(1)
})
