#!/usr/bin/env tsx
/**
 * Issue #537: CI check that a newly-added migration has a version exactly
 * one greater than the current highest existing version.
 *
 * CONTRIBUTING.md instructs contributors to "look at the highest-numbered
 * file in src/db/migrations/ and use the next integer." Nothing in CI
 * enforced this — a jump from e.g. 0033 to 0040, or filling a deliberate
 * gap like 0011, was only caught (or not) by a human reviewer.
 *
 * Usage: `tsx scripts/check-sequential-migrations.ts`
 *   - Exits 0 when migrations are sequential (allowing the documented
 *     deliberate gaps 0011 and 0014, which are already accounted for).
 *   - Exits 1 with a clear message naming the expected next version when
 *     the highest migration is not what it should be.
 *
 * Run alongside the existing "Migration dry-run verification" step in
 * .github/workflows/ci.yml.
 */

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Deliberate gaps in the migration version sequence, documented in
 * docs/DEPLOYMENT.md: "Versions 0011 and 0014 are unused (gaps are allowed;
 * see the loader in src/db/migrate.ts)."
 *
 * These should never be filled by a new migration. This set is used to
 * compute the expected next version without counting the gaps against
 * continuity.
 */
export const KNOWN_GAPS = new Set([11, 14])

/**
 * Parse migration filenames in a directory and return a sorted array of
 * version numbers. Only files matching `^\d+_.*\.sql$` are considered
 * (same pattern as src/db/migrate.ts's loadMigrationFiles).
 */
export function parseMigrationVersions(dir: string): number[] {
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f))
  const versions = files.map((f) => Number.parseInt(f.slice(0, f.indexOf('_')), 10))
  return versions.sort((a, b) => a - b)
}

/**
 * Given a sorted array of existing migration versions (and the set of known
 * deliberate gaps), compute the next expected version number. The next
 * version is the highest existing version + 1, skipping over any version
 * that falls in KNOWN_GAPS.
 *
 * Returns null if the versions array is empty (no migrations yet — the first
 * migration should be version 1).
 */
export function expectedNextVersion(versions: number[], knownGaps: Set<number> = KNOWN_GAPS): number {
  if (versions.length === 0) return 1
  let next = versions[versions.length - 1] + 1
  while (knownGaps.has(next)) next++
  return next
}

/**
 * Validate that the highest migration version is exactly what it should be.
 *
 * Returns null on success, or a human-readable error string on failure.
 */
export function validateSequential(versions: number[], knownGaps: Set<number> = KNOWN_GAPS): string | null {
  if (versions.length === 0) return null

  const highest = versions[versions.length - 1]

  // Compute what the highest version should be: start from 1 and step
  // through the sequence, skipping known gaps.
  let cursor = 0
  for (const v of versions) {
    let expected = cursor + 1
    while (knownGaps.has(expected)) expected++
    if (v !== expected) {
      // The expected next after the previous highest (cursor).
      const nextValid = (() => {
        let n = cursor + 1
        while (knownGaps.has(n)) n++
        return n
      })()
      return (
        `migration ${String(v).padStart(4, '0')} is out of sequence: ` +
        `expected version ${String(nextValid).padStart(4, '0')} after ${String(cursor).padStart(4, '0')}. ` +
        `Check src/db/migrations/ — the next migration should be ` +
        `${String(nextValid).padStart(4, '0')}_<description>.sql.`
      )
    }
    cursor = v
  }

  // All versions up to the highest are present (or accounted for by gaps).
  void highest
  return null
}

// Allow running directly (and importing from tests without side effects).
/* v8 ignore start -- run-directly entrypoint */
if (import.meta.url === `file://${process.argv[1]}`) {
  const migrationsDir = join(__dirname, '..', 'src', 'db', 'migrations')
  const versions = parseMigrationVersions(migrationsDir)
  const error = validateSequential(versions)
  if (error) {
    console.error(`[check-sequential-migrations] FAIL: ${error}`)
    process.exit(1)
  }
  const next = expectedNextVersion(versions)
  console.log(
    `[check-sequential-migrations] OK — ${versions.length} migration(s), ` +
    `highest is ${String(versions[versions.length - 1] ?? 0).padStart(4, '0')}. ` +
    `Next migration should be ${String(next).padStart(4, '0')}_<description>.sql.`
  )
}
/* v8 ignore stop */
