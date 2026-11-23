import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('.env.example configuration coverage', () => {
  it('documents every environment variable read by src/config.ts', () => {
    const source = readFileSync(`${root}/src/config.ts`, 'utf8')
    const example = readFileSync(`${root}/.env.example`, 'utf8')

    const helperReads = [...source.matchAll(/\b(?:str|int|bool|logLevel|nonceStore)\(env,\s*'([A-Z][A-Z0-9_]*)'/g)]
      .map((match) => match[1]!)
    const directReads = [...source.matchAll(/\benv(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)]
      .map((match) => match[1] ?? match[2]!)
    const documented = new Set(
      [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!),
    )

    const missing = [...new Set([...helperReads, ...directReads])]
      .filter((name) => !documented.has(name))
      .sort()

    expect(missing, `Missing from .env.example: ${missing.join(', ')}`).toEqual([])
  })
})
