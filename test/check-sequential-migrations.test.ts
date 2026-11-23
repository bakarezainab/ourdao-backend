import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  KNOWN_GAPS,
  expectedNextVersion,
  parseMigrationVersions,
  validateSequential,
} from '../scripts/check-sequential-migrations.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', 'src', 'db', 'migrations')

// Issue #537: CI check that a newly-added migration has a version exactly
// one greater than the previous highest, treating the documented deliberate
// gaps (0011 and 0014) as already-accounted-for.

describe('validateSequential (issue #537)', () => {
  it('passes for an empty migrations directory', () => {
    expect(validateSequential([])).toBeNull()
  })

  it('passes for a single migration starting at 1', () => {
    expect(validateSequential([1])).toBeNull()
  })

  it('passes for a fully sequential run', () => {
    expect(validateSequential([1, 2, 3, 4, 5])).toBeNull()
  })

  it('passes when the known gaps (11 and 14) are absent', () => {
    // The sequence 1–10, 12–13, 15 mirrors the actual repo (gaps at 11, 14).
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15]
    expect(validateSequential(v)).toBeNull()
  })

  it('fails when the first migration is not 1', () => {
    expect(validateSequential([2])).toMatch(/out of sequence/)
    expect(validateSequential([2])).toMatch(/expected version 0001/)
  })

  it('fails when a version jumps forward (e.g. 0033 → 0040)', () => {
    const versions = Array.from({ length: 33 }, (_, i) => i + 1).filter(
      (v) => !KNOWN_GAPS.has(v),
    )
    // Replace last version with a jump to 40.
    const jumped = [...versions.slice(0, -1), 40]
    const error = validateSequential(jumped)
    expect(error).not.toBeNull()
    expect(error).toMatch(/out of sequence/)
    expect(error).toMatch(/expected version 0033/)
  })

  it('fails when an old gap would be retroactively filled (e.g. inserting 0011)', () => {
    // Sequence 1–10, 11, 12, 13 (11 is a known gap — should not be filled).
    const versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    expect(validateSequential(versions)).not.toBeNull()
    expect(validateSequential(versions)).toMatch(/out of sequence/)
  })

  it('fails when an old gap would be retroactively filled (e.g. inserting 0014)', () => {
    const versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15]
    expect(validateSequential(versions)).not.toBeNull()
    expect(validateSequential(versions)).toMatch(/out of sequence/)
  })

  it('error message names the expected next version and is actionable', () => {
    const versions = [1, 2, 3, 10]
    const error = validateSequential(versions)
    expect(error).not.toBeNull()
    expect(error).toMatch(/expected version 0004/)
    expect(error).toMatch(/src\/db\/migrations/)
    expect(error).toMatch(/0004_<description>\.sql/)
  })
})

describe('expectedNextVersion (issue #537)', () => {
  it('returns 1 for an empty list', () => {
    expect(expectedNextVersion([])).toBe(1)
  })

  it('returns max + 1 for a simple sequence', () => {
    expect(expectedNextVersion([1, 2, 3])).toBe(4)
  })

  it('skips over known gaps when computing the next version', () => {
    // Current highest is 10. Next should be 12 (skipping the known gap 11).
    expect(expectedNextVersion([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(12)
    // Current highest is 13. Next should be 15 (skipping the known gap 14).
    expect(expectedNextVersion([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13])).toBe(15)
  })
})

describe('parseMigrationVersions (issue #537)', () => {
  it('parses the real migrations directory without error', () => {
    const versions = parseMigrationVersions(migrationsDir)
    expect(versions.length).toBeGreaterThan(0)
    expect(versions.every(Number.isInteger)).toBe(true)
  })

  it('sorts versions numerically', () => {
    const versions = parseMigrationVersions(migrationsDir)
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1])
    }
  })

  it('ignores non-sql and non-matching files', () => {
    // Confirm .gitkeep, README, etc. are excluded: each parsed version should
    // correspond to a real migration filename pattern.
    const files = readdirSync(migrationsDir)
    const sqlPattern = /^\d+_.*\.sql$/
    const nonMatching = files.filter((f) => !sqlPattern.test(f))
    const versions = parseMigrationVersions(migrationsDir)
    // If non-matching files existed and were counted, versions would be wrong.
    expect(versions.length).toBe(files.filter((f) => sqlPattern.test(f)).length)
    void nonMatching
  })
})

describe('existing migrations are sequential (issue #537)', () => {
  it('the real migrations directory passes the check', () => {
    const versions = parseMigrationVersions(migrationsDir)
    const error = validateSequential(versions)
    expect(error).toBeNull()
  })

  it('known gaps 0011 and 0014 are absent from the real directory', () => {
    const versions = parseMigrationVersions(migrationsDir)
    expect(versions).not.toContain(11)
    expect(versions).not.toContain(14)
  })

  it('the highest migration version is 0038', () => {
    const versions = parseMigrationVersions(migrationsDir)
    expect(versions[versions.length - 1]).toBe(38)
  })

  it('the expected next migration is 0039', () => {
    const versions = parseMigrationVersions(migrationsDir)
    expect(expectedNextVersion(versions)).toBe(39)
  })
})
