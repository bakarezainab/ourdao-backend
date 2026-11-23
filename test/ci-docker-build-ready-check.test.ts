/**
 * Issue #602: the docker-build job's "API entrypoint boots..." step only
 * ever curled GET /health against the running container. /health
 * deliberately does no database round trip, so it never proved that
 * /ready — the probe docs/DEPLOYMENT.md tells operators to use as the
 * load-balancer readiness check instead — works inside the built image.
 *
 * This reads the workflow file as plain text (no YAML dependency is
 * declared in package.json) and asserts the docker-build job curls /ready
 * against the already-running `api` container and checks the response
 * body's shape, not just the HTTP status code.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const workflow = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8')

function jobBlock(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:`)
  expect(start, `job '${name}' not found in ci.yml`).toBeGreaterThan(-1)
  const rest = workflow.slice(start + 1)
  // The next top-level (two-space-indented) job key, or end of file.
  const nextJob = rest.search(/\n {2}[a-zA-Z0-9_-]+:\n/)
  return nextJob === -1 ? rest : rest.slice(0, nextJob)
}

describe('ci.yml docker-build job exercises GET /ready (issue #602)', () => {
  const dockerBuild = jobBlock('docker-build')

  it('still curls GET /health (regression guard — this check stays as-is)', () => {
    expect(dockerBuild).toMatch(/curl[^\n]*\/health/)
  })

  it('curls GET /ready against the running api container', () => {
    expect(dockerBuild).toMatch(/curl[^\n]*(?:\$\{?.*PORT.*\}?|localhost:4000)\/ready/)
  })

  it("asserts the /ready response is 200 and status is 'ready', not just any 2xx", () => {
    expect(dockerBuild).toMatch(/code.*=.*200|http_code.*200/)
    expect(dockerBuild).toMatch(/\.status/)
    expect(dockerBuild).toMatch(/ready/)
  })

  it("accepts a cold-start indexer, matching the documented shape (indexer: 'cold_start' or ledger-lag fields)", () => {
    expect(dockerBuild).toMatch(/cold_start/)
    expect(dockerBuild).toMatch(/lastIndexedLedger/)
  })

  it('the /ready check runs before the api container is removed, so it reuses the same image/container as the /health check', () => {
    const readyIdx = dockerBuild.search(/curl[^\n]*\/ready/)
    const removeIdx = dockerBuild.indexOf('docker rm -f api')
    expect(readyIdx, 'no /ready curl found').toBeGreaterThan(-1)
    expect(removeIdx, 'no api container removal found').toBeGreaterThan(-1)
    expect(readyIdx).toBeLessThan(removeIdx)
  })
})
