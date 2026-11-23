import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Issue #474: scripts/clean-test-schemas.ts had no npm entry and no mention in
// CONTRIBUTING.md, unlike every other operational script.
describe('clean:test-schemas wiring (issue #474)', () => {
  it('package.json runs scripts/clean-test-schemas.ts via tsx', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['clean:test-schemas']).toBe('tsx scripts/clean-test-schemas.ts')
  })

  it('CONTRIBUTING.md tells contributors when to run it', () => {
    expect(readFileSync('CONTRIBUTING.md', 'utf-8')).toContain('npm run clean:test-schemas')
  })
})

// Issue #472: the single-lookup proposal routes were missing from README.md.
describe('README documents single-lookup proposal routes (issue #472)', () => {
  const readme = readFileSync('README.md', 'utf-8')

  it('lists GET /api/proposals/loan/:id in the Quick reference table and the Loans list', () => {
    expect(readme).toContain('| `GET /api/proposals/loan/:id` |')
    expect(readme).toContain('- `GET /api/proposals/loan/:id` —')
  })

  it('lists GET /api/proposals/treasury/:id in the Quick reference table and the Treasury list', () => {
    expect(readme).toContain('| `GET /api/proposals/treasury/:id` |')
    expect(readme).toContain('- `GET /api/proposals/treasury/:id` —')
  })
})
