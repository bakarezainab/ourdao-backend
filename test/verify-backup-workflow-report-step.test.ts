import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

// Issue #594: "Report verification results" checked a bare `$?`, which
// reflects the exit status of commands run earlier within its own step
// script, not the outcome of the preceding "Run backup verification script"
// step — `$?` does not cross a step boundary. No YAML parser dependency
// needed here (same reasoning as test/docker-compose-redis-healthcheck.test.ts):
// this only needs to confirm the relevant step blocks, not interpret the
// whole workflow's structure.
describe('verify-backup.yml: report step reflects the verification step outcome (issue #594)', () => {
  const workflow = readFileSync(`${root}/.github/workflows/verify-backup.yml`, 'utf8')

  it('gives "Run backup verification script" an explicit id', () => {
    const runBlock = /- name: Run backup verification script\n(?: {8}.*\n)+/.exec(workflow)?.[0]
    expect(runBlock, 'run-verification step block not found').toBeTruthy()
    expect(runBlock).toMatch(/id:\s*verify_backup/)
  })

  it('has "Report verification results" check that step\'s outcome, not a bare $?', () => {
    const reportBlock = /- name: Report verification results\n(?: {8}.*\n)+/.exec(workflow)?.[0]
    expect(reportBlock, 'report step block not found').toBeTruthy()

    expect(reportBlock).not.toMatch(/\$\?/)
    expect(reportBlock).toMatch(/steps\.verify_backup\.outcome/)
  })
})
