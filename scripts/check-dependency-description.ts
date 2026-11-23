#!/usr/bin/env tsx
/**
 * Issue #591: docs/DEPENDENCY-LICENSES.md's "Direct Dependency Changes"
 * section claims CI fails when package.json's dependencies/devDependencies
 * are modified and the PR description doesn't name the change — but no
 * script implemented that check. This does.
 *
 * Scoped specifically to the `dependencies`/`devDependencies` fields' diff
 * (not any package.json change) so a lockfile-only change, or an edit to
 * e.g. `scripts`/`version`, never triggers it.
 */

import { execSync } from 'child_process'

export interface DependencyChange {
  added: string[]
  removed: string[]
  changed: string[]
}

export function getDependencyFields(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): Record<string, string> {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
}

export function diffDependencyFields(
  basePkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
  headPkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
): DependencyChange {
  const base = getDependencyFields(basePkg)
  const head = getDependencyFields(headPkg)
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []

  for (const name of Object.keys(head)) {
    if (!(name in base)) added.push(name)
    else if (base[name] !== head[name]) changed.push(name)
  }
  for (const name of Object.keys(base)) {
    if (!(name in head)) removed.push(name)
  }
  return { added, removed, changed }
}

export function hasDependencyChange(diff: DependencyChange): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0
}

export function describesDependencyChange(
  prBody: string | null | undefined,
  diff: DependencyChange,
): { described: boolean; missing: string[] } {
  const body = (prBody ?? '').toLowerCase()
  const names = [...diff.added, ...diff.removed, ...diff.changed]
  const missing = names.filter((name) => !body.includes(name.toLowerCase()))
  return { described: missing.length === 0, missing }
}

function readPackageJsonAt(ref: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  const content = execSync(`git show ${ref}:package.json`, { encoding: 'utf-8' })
  return JSON.parse(content)
}

async function main() {
  const baseSha = process.env.BASE_SHA
  const headSha = process.env.HEAD_SHA || 'HEAD'
  const prBody = process.env.PR_BODY ?? ''

  if (!baseSha) {
    console.log('[check-dependency-description] BASE_SHA not set — not a pull_request run, skipping')
    return
  }

  const basePkg = readPackageJsonAt(baseSha)
  const headPkg = readPackageJsonAt(headSha)
  const diff = diffDependencyFields(basePkg, headPkg)

  if (!hasDependencyChange(diff)) {
    console.log('[check-dependency-description] No dependencies/devDependencies change in package.json — skipping')
    return
  }

  console.log('[check-dependency-description] Dependency changes detected:')
  if (diff.added.length) console.log(`  added: ${diff.added.join(', ')}`)
  if (diff.removed.length) console.log(`  removed: ${diff.removed.join(', ')}`)
  if (diff.changed.length) console.log(`  version changed: ${diff.changed.join(', ')}`)

  const { described, missing } = describesDependencyChange(prBody, diff)
  if (!described) {
    console.error(
      `\n[check-dependency-description] ❌ PR description does not mention: ${missing.join(', ')}\n` +
        'Dependency changes to package.json must be called out by name in the PR description. ' +
        'See docs/DEPENDENCY-LICENSES.md#direct-dependency-changes.',
    )
    process.exit(1)
  }

  console.log('[check-dependency-description] ✅ PR description mentions all dependency changes')
}

main().catch((err) => {
  console.error('[check-dependency-description] Unexpected error:', err)
  process.exit(1)
})
