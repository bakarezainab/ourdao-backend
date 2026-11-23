import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('SECURITY.md (issue #599)', () => {
  it('exists at the repository root and points to private vulnerability reporting, not a public issue', () => {
    const security = readFileSync(`${root}/SECURITY.md`, 'utf8')

    expect(security).toMatch(/private vulnerability reporting/i)
    expect(security).toMatch(/do not open a public issue/i)
    expect(security).toMatch(/what you found/i)
    expect(security).toMatch(/how to reproduce/i)
    expect(security).toMatch(/what an attacker could do/i)
    // The architectural boundary (no custody, read-only) is relevant context
    // for what kind of report makes sense against this specific service.
    expect(security).toMatch(/no custody|read-only/i)
  })

  it("CONTRIBUTING.md's security section points at SECURITY.md as the source of truth", () => {
    const contributing = readFileSync(`${root}/CONTRIBUTING.md`, 'utf8')
    const section = contributing.slice(contributing.indexOf('## Reporting a security issue'))

    expect(section).toMatch(/\[SECURITY\.md\]\(\.\/SECURITY\.md\)/)
  })
})
