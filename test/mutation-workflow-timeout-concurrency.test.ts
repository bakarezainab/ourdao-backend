import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

// Issue #582: unlike ci.yml and bench-events.yml, mutation.yml's
// mutation-test job had no timeout-minutes and the workflow had no
// concurrency group, despite running a serialized (concurrency: 1),
// resource-intensive Stryker suite against a real Postgres database on
// both a weekly schedule and workflow_dispatch -- exactly the profile that
// needs an explicit wall-clock bound and a group that queues (rather than
// cancels) an overlapping manual re-run. No YAML parser dependency needed
// (same reasoning as test/docker-compose-redis-healthcheck.test.ts): this
// only needs to confirm the workflow- and job-level keys, not interpret the
// whole file's structure.
describe('mutation.yml: timeout and concurrency group (issue #582)', () => {
  it('gives the mutation-test job an explicit timeout-minutes', () => {
    const workflow = readFileSync(`${root}/.github/workflows/mutation.yml`, 'utf8')
    const jobBlock = /^ {2}mutation-test:\n(?: {4}.*\n|\n)+/m.exec(workflow)?.[0]
    expect(jobBlock, 'mutation-test job block not found').toBeTruthy()
    expect(jobBlock).toMatch(/timeout-minutes:\s*\d+/)
  })

  it('has a workflow-level concurrency group that queues rather than cancels an overlapping run', () => {
    const workflow = readFileSync(`${root}/.github/workflows/mutation.yml`, 'utf8')
    const concurrencyBlock = /^concurrency:\n(?: {2}.*\n)+/m.exec(workflow)?.[0]
    expect(concurrencyBlock, 'top-level concurrency block not found').toBeTruthy()
    expect(concurrencyBlock).toMatch(/group:/)
    expect(concurrencyBlock).toMatch(/cancel-in-progress:\s*false/)
  })

  it('still triggers on schedule and workflow_dispatch only, unchanged by the fix', () => {
    const workflow = readFileSync(`${root}/.github/workflows/mutation.yml`, 'utf8')
    expect(workflow).toMatch(/schedule:/)
    expect(workflow).toMatch(/cron:\s*'0 3 \* \* 1'/)
    expect(workflow).toMatch(/workflow_dispatch:/)
  })
})
