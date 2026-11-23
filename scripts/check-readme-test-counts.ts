#!/usr/bin/env tsx
/**
 * Issue #580 — README's "Testing" section states an exact test-file and
 * test-case count ("N tests across M files"). It drifted once before (issue
 * #355-358 fixed "145 tests across 18 files" -> "597 tests across 72
 * files") by hand-editing the number, with nothing to catch the next drift —
 * which is exactly what happened. This re-derives both numbers from the
 * actual test/ directory and fails the build if README disagrees, so a PR
 * that adds or removes tests is forced to update the stated count instead of
 * leaving it to go stale again.
 *
 * Counts `it(`/`test(` call sites (including `.skip`/`.only`/`.each`/`.todo`/
 * `.concurrent` variants) via the TypeScript AST rather than a regex, so a
 * commented-out or string-literal occurrence of "it(" never inflates the
 * count. This mirrors call-site counting, not expanded `.each()` cases — the
 * same convention README's existing number already used.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DIR = join(__dirname, '..', 'test')
const README_PATH = join(__dirname, '..', 'README.md')

export function listTestFiles(dir: string = TEST_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
}

function isTestCallRoot(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === 'it' || expr.text === 'test'
  if (ts.isPropertyAccessExpression(expr)) return isTestCallRoot(expr.expression)
  // `test.each([...])(name, fn)`: the outer call's callee is itself a call
  // (`test.each([...])`), so unwrap one level before checking the root.
  if (ts.isCallExpression(expr)) return isTestCallRoot(expr.expression)
  return false
}

export function countTestCasesInSource(source: string, fileName = 'file.ts'): number {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  let count = 0

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isTestCallRoot(node.expression)) {
      const firstArg = node.arguments[0]
      if (firstArg && (ts.isStringLiteralLike(firstArg) || ts.isTemplateExpression(firstArg))) {
        count += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return count
}

export function countTestFilesAndCases(dir: string = TEST_DIR): { files: number; cases: number } {
  const files = listTestFiles(dir)
  const cases = files.reduce((sum, name) => sum + countTestCasesInSource(readFileSync(join(dir, name), 'utf8'), name), 0)
  return { files: files.length, cases }
}

export function parseReadmeTestCounts(readme: string): { cases: number; files: number } | null {
  const match = /(\d[\d,]*)\s+tests across\s+(\d+)\s+files/.exec(readme)
  const casesStr = match?.[1]
  const filesStr = match?.[2]
  if (!casesStr || !filesStr) return null
  return { cases: Number.parseInt(casesStr.replace(/,/g, ''), 10), files: Number.parseInt(filesStr, 10) }
}

function main(): void {
  const actual = countTestFilesAndCases()
  const readme = readFileSync(README_PATH, 'utf8')
  const stated = parseReadmeTestCounts(readme)

  if (!stated) {
    console.error(
      "[check-readme-test-counts] Could not find a \"N tests across M files\" sentence in README.md's Testing section."
    )
    process.exit(1)
  }

  console.log(`[check-readme-test-counts] actual: ${actual.cases} tests across ${actual.files} files`)
  console.log(`[check-readme-test-counts] README states: ${stated.cases} tests across ${stated.files} files`)

  if (actual.cases !== stated.cases || actual.files !== stated.files) {
    console.error(
      '\n[check-readme-test-counts] ❌ README.md\'s stated test count is out of date. ' +
        `Update the "${stated.cases} tests across ${stated.files} files" sentence in README.md's ` +
        `Testing section to "${actual.cases} tests across ${actual.files} files".`
    )
    process.exit(1)
  }

  console.log('[check-readme-test-counts] ✅ README.md\'s stated test count matches the actual test/ directory')
}

// `npm run check:readme-test-counts` — guarded so importing the pure
// functions above (as test/check-readme-test-counts.test.ts does) never
// triggers a process.exit from main().
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main()
}
