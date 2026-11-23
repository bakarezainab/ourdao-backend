import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

// Issue #579: CONTRIBUTING.md and CI (via `npm run openapi:validate` in
// ci.yml's build-and-test job) both enforce a CHANGELOG.md entry for
// user-visible changes and a regenerated openapi.json for route changes,
// but the PR template's checklist never mentioned either -- a contributor
// following the template faithfully could still fail CI or silently skip
// the changelog. No YAML/Markdown parser dependency needed (same reasoning
// as test/docker-compose-redis-healthcheck.test.ts): this only needs to
// confirm the checklist text, not interpret the template's full structure.
describe('PULL_REQUEST_TEMPLATE.md: CHANGELOG.md and openapi.json checklist items (issue #579)', () => {
  it("adds a checklist line for CHANGELOG.md's [Unreleased] section", () => {
    const template = readFileSync(`${root}/.github/PULL_REQUEST_TEMPLATE.md`, 'utf8')
    expect(template).toMatch(/- \[ \] .*CHANGELOG\.md.*\[Unreleased\]/)
  })

  it('adds a checklist line for regenerating and committing openapi.json', () => {
    const template = readFileSync(`${root}/.github/PULL_REQUEST_TEMPLATE.md`, 'utf8')
    expect(template).toMatch(/- \[ \] .*npm run openapi:generate.*openapi\.json/)
  })

  it('places both additions inside the existing Backend checklist section, not a new section', () => {
    const template = readFileSync(`${root}/.github/PULL_REQUEST_TEMPLATE.md`, 'utf8')
    const backendSection = /## Backend checklist\n(?:.*\n)+?(?=\n## |\n### )/.exec(template)?.[0]
    expect(backendSection, 'Backend checklist section not found').toBeTruthy()
    expect(backendSection).toMatch(/CHANGELOG\.md/)
    expect(backendSection).toMatch(/openapi\.json/)

    // The template's existing sections survive unchanged.
    expect(template).toMatch(/## Testing/)
    expect(template).toMatch(/### Schema changes/)
    expect(template).toMatch(/### New contract events handled/)
  })
})
