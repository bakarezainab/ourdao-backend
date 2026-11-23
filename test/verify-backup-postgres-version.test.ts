import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

// Issue #588: scripts/verify-backup.sh defaulted POSTGRES_VERSION to 17 and
// .github/workflows/verify-backup.yml independently hardcoded postgres:17 for
// its test-backup container, while every other Postgres instance this
// project runs against (docker-compose.yml, ci.yml, mutation.yml,
// bench-events.yml) pins 16. Backup verification is meant to prove a real
// backup restores cleanly into the Postgres version actually deployed — a
// mismatched major version doesn't prove that. No YAML parser dependency
// needed here (same reasoning as test/docker-compose-redis-healthcheck.test.ts):
// this only needs to confirm the literal version strings agree.
describe('backup verification: Postgres major version (issue #588)', () => {
  it("verify-backup.sh's POSTGRES_VERSION default matches the project's postgres:16 pin", () => {
    const script = readFileSync(`${root}/scripts/verify-backup.sh`, 'utf8')
    expect(script).toMatch(/POSTGRES_VERSION="\$\{POSTGRES_VERSION:-16\}"/)
  })

  it("verify-backup.yml's test-backup container uses postgres:16, not a different major version", () => {
    const workflow = readFileSync(`${root}/.github/workflows/verify-backup.yml`, 'utf8')
    expect(workflow).toMatch(/postgres:16-alpine/)
    expect(workflow).not.toMatch(/postgres:17/)
  })

  it('agrees with docker-compose.yml and ci.yml on the same Postgres major version', () => {
    const script = readFileSync(`${root}/scripts/verify-backup.sh`, 'utf8')
    const workflow = readFileSync(`${root}/.github/workflows/verify-backup.yml`, 'utf8')
    const compose = readFileSync(`${root}/docker-compose.yml`, 'utf8')
    const ci = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8')

    const scriptVersion = /POSTGRES_VERSION:-(\d+)/.exec(script)?.[1]
    const workflowVersion = /postgres:(\d+)-alpine/.exec(workflow)?.[1]
    const composeVersion = /postgres:(\d+)-alpine/.exec(compose)?.[1]
    const ciVersion = /postgres:(\d+)-alpine/.exec(ci)?.[1]

    expect(scriptVersion).toBeDefined()
    expect(scriptVersion).toBe(workflowVersion)
    expect(scriptVersion).toBe(composeVersion)
    expect(scriptVersion).toBe(ciVersion)
  })
})
