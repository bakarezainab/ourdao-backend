import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

// Issue #589: .trivyignore's policy comment claimed CI only fails the build
// on CRITICAL severity CVEs, but .github/workflows/ci.yml's docker-build job
// also fails on HIGH ("Enforce vulnerability policy (fail on HIGH/CRITICAL)",
// severity: 'CRITICAL,HIGH', exit-code: '1') — contradicting the documented
// policy. docs/DEPLOYMENT.md's "Container security and image scanning"
// section already states the real policy (HIGH or CRITICAL) correctly, so it
// serves as the tie-breaker .trivyignore's comment must agree with. No YAML
// parser dependency needed (same reasoning as
// test/docker-compose-redis-healthcheck.test.ts): this only needs to confirm
// the documented text, not interpret the workflow's structure.
describe('.trivyignore policy comment matches the enforced CI policy (issue #589)', () => {
  it('states the build fails on HIGH or CRITICAL, not CRITICAL alone', () => {
    const trivyignore = readFileSync(`${root}/.trivyignore`, 'utf8')
    expect(trivyignore).toMatch(/HIGH or CRITICAL/i)
    expect(trivyignore).not.toMatch(/failing the build on any CRITICAL severity/i)
  })

  it("agrees with docs/DEPLOYMENT.md's documented failure policy", () => {
    const trivyignore = readFileSync(`${root}/.trivyignore`, 'utf8')
    const deployment = readFileSync(`${root}/docs/DEPLOYMENT.md`, 'utf8')
    expect(deployment).toMatch(/Builds fail on any detected `HIGH` or `CRITICAL` severity vulnerability/)
    expect(trivyignore).toMatch(/HIGH or CRITICAL/i)
  })

  it("ci.yml's docker-build job actually enforces HIGH/CRITICAL, matching the documented policy", () => {
    const ci = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8')
    expect(ci).toMatch(/Enforce vulnerability policy \(fail on HIGH\/CRITICAL\)/)
    expect(ci).toMatch(/severity:\s*'CRITICAL,HIGH'/)
  })
})
