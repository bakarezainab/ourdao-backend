import { describe, expect, it } from 'vitest'
import {
  describesDependencyChange,
  diffDependencyFields,
  hasDependencyChange,
} from '../scripts/check-dependency-description.js'

// Issue #591: docs/DEPENDENCY-LICENSES.md's "Direct Dependency Changes"
// section documents a CI check that scripts/check-licenses.ts never actually
// implemented. These exercise the pure diff/description logic directly
// (no git invocation, no PR body network call) against real package.json
// diff shapes.
describe('check-dependency-description (issue #591)', () => {
  it('reports no change for a lockfile-only edit (package.json dependencies untouched)', () => {
    const base = { dependencies: { fastify: '^5.0.0' }, devDependencies: { vitest: '^2.0.0' } }
    const head = { dependencies: { fastify: '^5.0.0' }, devDependencies: { vitest: '^2.0.0' } }
    const diff = diffDependencyFields(base, head)
    expect(hasDependencyChange(diff)).toBe(false)
  })

  it('detects an added dependency', () => {
    const base = { dependencies: { fastify: '^5.0.0' } }
    const head = { dependencies: { fastify: '^5.0.0', ioredis: '^5.4.1' } }
    const diff = diffDependencyFields(base, head)
    expect(diff).toEqual({ added: ['ioredis'], removed: [], changed: [] })
    expect(hasDependencyChange(diff)).toBe(true)
  })

  it('detects a removed dependency', () => {
    const base = { dependencies: { fastify: '^5.0.0', ioredis: '^5.4.1' } }
    const head = { dependencies: { fastify: '^5.0.0' } }
    const diff = diffDependencyFields(base, head)
    expect(diff).toEqual({ added: [], removed: ['ioredis'], changed: [] })
  })

  it('detects a version bump', () => {
    const base = { devDependencies: { vitest: '^2.0.0' } }
    const head = { devDependencies: { vitest: '^3.0.0' } }
    const diff = diffDependencyFields(base, head)
    expect(diff).toEqual({ added: [], removed: [], changed: ['vitest'] })
  })

  it('fails when the PR description does not name the changed package', () => {
    const diff = diffDependencyFields({ dependencies: {} }, { dependencies: { ioredis: '^5.4.1' } })
    const result = describesDependencyChange('Bumps some stuff around caching.', diff)
    expect(result.described).toBe(false)
    expect(result.missing).toEqual(['ioredis'])
  })

  it('passes when the PR description names the changed package, case-insensitively', () => {
    const diff = diffDependencyFields({ dependencies: {} }, { dependencies: { ioredis: '^5.4.1' } })
    const result = describesDependencyChange('Adds IoRedis for the shared cache.', diff)
    expect(result.described).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('requires every changed package to be named, not just one of several', () => {
    const diff = diffDependencyFields(
      { dependencies: {} },
      { dependencies: { ioredis: '^5.4.1', 'p-limit': '^6.0.0' } },
    )
    const result = describesDependencyChange('Adds ioredis for caching.', diff)
    expect(result.described).toBe(false)
    expect(result.missing).toEqual(['p-limit'])
  })

  it('treats a missing PR body as empty rather than throwing', () => {
    const diff = diffDependencyFields({ dependencies: {} }, { dependencies: { ioredis: '^5.4.1' } })
    const result = describesDependencyChange(null, diff)
    expect(result.described).toBe(false)
  })
})
