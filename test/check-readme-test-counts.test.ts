import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { countTestCasesInSource, countTestFilesAndCases, parseReadmeTestCounts } from '../scripts/check-readme-test-counts.js'

const root = fileURLToPath(new URL('..', import.meta.url))

// Issue #580: README's "N tests across M files" sentence drifted stale twice
// already (most recently "145 tests across 18 files" vs. an actual 70 files)
// purely from hand-editing with nothing to catch the next drift. These
// exercise the counting logic directly against real source shapes, and the
// real test/ directory, so a future PR that adds a test file without
// updating README fails loudly instead of silently going stale again.
describe('check-readme-test-counts (issue #580)', () => {
  describe('countTestCasesInSource', () => {
    it('counts it( and test( call sites', () => {
      const source = `
        describe('a', () => {
          it('does a thing', () => {})
          test('does another thing', () => {})
        })
      `
      expect(countTestCasesInSource(source)).toBe(2)
    })

    it('counts .skip, .only, .each, and .todo variants', () => {
      const source = `
        it.skip('a', () => {})
        it.only('b', () => {})
        test.each([1, 2])('c %i', () => {})
        it.todo('d')
      `
      expect(countTestCasesInSource(source)).toBe(4)
    })

    it('does not count it( or test( inside a comment', () => {
      const source = `
        // it('not a real test', () => {})
        /* test('also not real', () => {}) */
        it('the one real test', () => {})
      `
      expect(countTestCasesInSource(source)).toBe(1)
    })

    it('does not count an unrelated function named it or test', () => {
      const source = `
        function test(x) { return x }
        const result = test(5)
        describe('a', () => {})
      `
      expect(countTestCasesInSource(source)).toBe(0)
    })

    it('does not count it( or test( called with a non-string first argument', () => {
      const source = `
        const name = 'dynamic'
        it(name, () => {})
      `
      expect(countTestCasesInSource(source)).toBe(0)
    })

    it('counts a template-literal test name', () => {
      const source = "it(`uses ${1} interpolation`, () => {})"
      expect(countTestCasesInSource(source)).toBe(1)
    })
  })

  describe('parseReadmeTestCounts', () => {
    it('parses the stated "N tests across M files" sentence', () => {
      expect(parseReadmeTestCounts('Intro text.\n\n597 tests across 72 files, covering:\n')).toEqual({
        cases: 597,
        files: 72,
      })
    })

    it('returns null when README has no such sentence', () => {
      expect(parseReadmeTestCounts('Nothing relevant here.')).toBeNull()
    })
  })

  describe('countTestFilesAndCases against the real test/ directory', () => {
    it('matches the count README.md actually states', () => {
      const stated = parseReadmeTestCounts(readFileSync(`${root}/README.md`, 'utf8'))
      expect(stated).not.toBeNull()
      expect(countTestFilesAndCases()).toEqual(stated)
    })
  })
})
