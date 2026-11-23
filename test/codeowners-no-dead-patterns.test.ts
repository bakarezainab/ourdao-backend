import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CODEOWNERS_PATH } from '../scripts/branch-protection.js'

// Issue #598: bun.lock, bun.lockb, yarn.lock, pnpm-lock.yaml and Cargo.lock
// have no matching file anywhere in this npm-only, Rust-free repo, and
// public/ has no matching directory either — dead entries that can never
// trigger the required-review rule CODEOWNERS exists to enforce.
describe('CODEOWNERS has no dead patterns (issue #598)', () => {
  const codeowners = readFileSync(DEFAULT_CODEOWNERS_PATH, 'utf-8')
  const patterns = codeowners
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0]!)

  it.each(['bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'public/'])(
    'no longer lists %s',
    (pattern) => {
      expect(patterns).not.toContain(pattern)
    }
  )

  it.each(['package.json', 'package-lock.json'])('still lists %s unchanged', (pattern) => {
    expect(patterns).toContain(pattern)
  })

  it('still covers .vscode/, .devcontainer/ and .github/', () => {
    expect(patterns).toContain('.vscode/')
    expect(patterns).toContain('.devcontainer/')
    expect(patterns).toContain('.github/')
  })

  // Issue #473: the documented code-owner paths must actually have a pattern.
  it.each(['src/', 'src/auth.ts', 'src/indexer/', 'src/db/migrations/'])('lists %s', (pattern) => {
    expect(patterns).toContain(pattern)
  })

  it('lists exactly the expected patterns — the six dead ones are gone', () => {
    expect(patterns).toEqual([
      '.vscode/',
      '.devcontainer/',
      'package.json',
      'package-lock.json',
      '.github/',
      'src/',
      'src/auth.ts',
      'src/indexer/',
      'src/db/migrations/',
    ])
  })
})
