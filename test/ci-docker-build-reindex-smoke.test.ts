import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

// Issue #581: ci.yml's docker-build job smoke-tests the API and worker
// entrypoints inside the built image, but never `node dist/indexer/reindex.js`
// -- the documented recovery path for a detected reorg and for quarantined-
// event repair (docs/REORG_RECOVERY.md, docs/DEPLOYMENT.md). An image where
// reindex silently fails to start would only surface during an actual
// incident. No YAML parser dependency needed (same reasoning as
// test/docker-compose-redis-healthcheck.test.ts and
// test/trivyignore-policy-doc.test.ts): this only needs to confirm the new
// step's presence and shape, not interpret the whole workflow's structure.
describe('ci.yml: docker-build job smoke-tests node dist/indexer/reindex.js (issue #581)', () => {
  it('runs reindex.js against the built image and asserts it exits cleanly', () => {
    const ci = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8')
    const dockerBuildJob = /^ {2}docker-build:\n(?: {4}.*\n|\n)+/m.exec(ci)?.[0]
    expect(dockerBuildJob, 'docker-build job block not found').toBeTruthy()

    expect(dockerBuildJob).toMatch(/node dist\/indexer\/reindex\.js/)
    // Reuses the job's existing env vars and Postgres service rather than a
    // parallel setup.
    expect(dockerBuildJob).toMatch(/"\$DB_URL"/)
    expect(dockerBuildJob).toMatch(/"\$IMAGE"/)
  })

  it('seeds an event and asserts the derived members table was actually populated by the fold, not just that the process exited 0', () => {
    const ci = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8')
    const reindexStep = /node dist\/indexer\/reindex\.js rebuilds derived tables from the event log\n(?:.*\n)+?(?=\n {6}- name:|\n*$)/.exec(
      ci
    )?.[0]
    expect(reindexStep, 'reindex smoke-test step not found').toBeTruthy()

    expect(reindexStep).toMatch(/INSERT INTO events/)
    expect(reindexStep).toMatch(/SELECT count\(\*\) FROM members/)
    expect(reindexStep).toMatch(/test "\$member_count" = 1/)
  })

  it('still runs the pre-existing API and worker entrypoint checks, unchanged by the fix', () => {
    const ci = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8')
    expect(ci).toMatch(/API entrypoint boots and the HEALTHCHECK reports healthy/)
    expect(ci).toMatch(/worker entrypoint boots and exits 0 on SIGTERM/)
  })
})
