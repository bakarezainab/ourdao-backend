// Regression tests for the audit-logging fallback in clearRecordedReorg.
//
// Two callers reach this function:
//   1. The CLI (`npm run reorg:clear`), which calls clearRecordedReorg() with
//      NO arguments. There is no authenticated admin, so the audit row and
//      reorg_halts.cleared_by must fall back to 'operator', with a null IP.
//   2. POST /api/admin/clear-reorg, which passes a real { adminAddress,
//      ipAddress }. Those values must be recorded as given, never replaced by
//      the 'operator' fallback.
//
// A future refactor must not "fix" one path by regressing the other.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { clearRecordedReorg } from '../src/indexer/clear-reorg.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'
import type { AdminAuditLogRow } from '../src/types.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function insertHalt(contractId = 'CCLIAUDIT', ledger = 777): Promise<void> {
  await query(
    `INSERT INTO reorg_halts (contract_id, last_ledger, last_ledger_hash, detail)
     VALUES ($1, $2, $3, 'cli audit regression')`,
    [contractId, ledger, `HASH_${ledger}`]
  )
}

async function auditRows(): Promise<AdminAuditLogRow[]> {
  return query<AdminAuditLogRow>(
    "SELECT * FROM admin_audit_log WHERE action = 'clear_reorg' ORDER BY id DESC"
  )
}

async function clearedBy(): Promise<(string | null)[]> {
  const rows = await query<{ cleared_by: string | null }>(
    'SELECT cleared_by FROM reorg_halts ORDER BY id'
  )
  return rows.map((r) => r.cleared_by)
}

describe('clearRecordedReorg audit fallback: CLI vs HTTP caller', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  describe('CLI path (no admin context)', () => {
    it('no-argument call writes an audit row attributed to "operator" with a null IP', async () => {
      await insertHalt()

      const result = await clearRecordedReorg()

      expect(result.cleared).toBe(1)
      const rows = await auditRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.admin_address).toBe('operator')
      expect(rows[0]!.ip_address).toBeNull()
      expect(rows[0]!.payload).toMatchObject({
        contract_id: 'CCLIAUDIT',
        last_ledger: 777,
        cleared: 1,
      })
    })

    it('no-argument call also stamps reorg_halts.cleared_by with "operator"', async () => {
      await insertHalt()
      await clearRecordedReorg()
      expect(await clearedBy()).toEqual(['operator'])
    })

    it('logger-only argument (the { log } overload) still falls back to "operator"', async () => {
      await insertHalt()
      const lines: string[] = []

      await clearRecordedReorg({ log: (msg: string) => lines.push(msg) })

      const rows = await auditRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.admin_address).toBe('operator')
      expect(rows[0]!.ip_address).toBeNull()
      expect(await clearedBy()).toEqual(['operator'])
      // the injected logger received the output, not console
      expect(lines.some((l) => l.includes('[reorg:clear] cleared 1 record(s)'))).toBe(true)
    })

    it('an empty context object falls back to "operator" too', async () => {
      await insertHalt()
      await clearRecordedReorg({})
      const rows = await auditRows()
      expect(rows[0]!.admin_address).toBe('operator')
      expect(rows[0]!.ip_address).toBeNull()
    })

    it('writes no audit row when there is nothing to clear', async () => {
      const result = await clearRecordedReorg()
      expect(result).toEqual({ halt: null, cleared: 0 })
      expect(await auditRows()).toHaveLength(0)
    })
  })

  describe('HTTP-shaped path (real admin context)', () => {
    it('records the real adminAddress and ipAddress, not the "operator" fallback', async () => {
      await insertHalt()

      await clearRecordedReorg({ adminAddress: 'GREALADMIN', ipAddress: '203.0.113.7' })

      const rows = await auditRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.admin_address).toBe('GREALADMIN')
      expect(rows[0]!.admin_address).not.toBe('operator')
      expect(rows[0]!.ip_address).toBe('203.0.113.7')
      expect(await clearedBy()).toEqual(['GREALADMIN'])
    })

    it('keeps a provided IP even when adminAddress is missing (address falls back, IP does not)', async () => {
      await insertHalt()

      await clearRecordedReorg({ ipAddress: '198.51.100.9' })

      const rows = await auditRows()
      expect(rows[0]!.admin_address).toBe('operator')
      expect(rows[0]!.ip_address).toBe('198.51.100.9')
    })

    it('CLI and HTTP calls in sequence produce distinct, correctly attributed rows', async () => {
      await insertHalt('CFIRST', 1)
      await clearRecordedReorg({ adminAddress: 'GHTTPADMIN', ipAddress: '192.0.2.1' })

      await insertHalt('CSECOND', 2)
      await clearRecordedReorg()

      const rows = await auditRows() // newest first
      expect(rows).toHaveLength(2)
      expect(rows[0]!.admin_address).toBe('operator')
      expect(rows[0]!.ip_address).toBeNull()
      expect(rows[1]!.admin_address).toBe('GHTTPADMIN')
      expect(rows[1]!.ip_address).toBe('192.0.2.1')
    })
  })

  describe('real CLI entrypoint (subprocess)', () => {
    // Runs the same file `npm run reorg:clear` runs, so the
    // `import.meta.url === file://${process.argv[1]}` block is exercised for
    // real. The child inherits DATABASE_URL and PGOPTIONS from test/setup.ts,
    // so it talks to this worker's schema.
    it('`tsx src/indexer/clear-reorg.ts` clears the halt and audits it as "operator"', async () => {
      await insertHalt('CSUBPROC', 4242)

      const { stdout } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', 'src/indexer/clear-reorg.ts'],
        { cwd: repoRoot, env: process.env, timeout: 30_000 }
      )

      expect(stdout).toContain('[reorg:clear] cleared 1 record(s)')
      const rows = await auditRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.admin_address).toBe('operator')
      expect(rows[0]!.ip_address).toBeNull()
      expect(rows[0]!.payload).toMatchObject({ contract_id: 'CSUBPROC', last_ledger: 4242 })
      expect(await clearedBy()).toEqual(['operator'])
    }, 45_000)

    it('exits 0 and writes no audit row when no halt is recorded', async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', 'src/indexer/clear-reorg.ts'],
        { cwd: repoRoot, env: process.env, timeout: 30_000 }
      )

      expect(stdout).toContain('nothing to do')
      expect(await auditRows()).toHaveLength(0)
    }, 45_000)
  })
})
