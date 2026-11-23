import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { generateOpenApiSpec } from '../scripts/generate-openapi-spec.js'

const root = fileURLToPath(new URL('..', import.meta.url))

type Spec = { paths: Record<string, Record<string, unknown>> }

// Issue #488: CI's openapi:validate step only catches a stale openapi.json at
// PR time. This runs the same generator in `npm test` so a route added
// without regenerating the spec fails fast locally.
describe('openapi.json stays in sync with the routes (issue #488)', () => {
  let generated: Spec

  beforeAll(async () => {
    generated = JSON.parse(JSON.stringify(await generateOpenApiSpec())) as Spec
  })

  it('matches the committed openapi.json', () => {
    const committed = JSON.parse(readFileSync(`${root}openapi.json`, 'utf8')) as Spec
    expect(generated).toEqual(committed)
  })

  it('has an entry for every route src/api/routes/index.ts registers', () => {
    const source = readFileSync(`${root}src/api/routes/index.ts`, 'utf8')
    const routes = [...source.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'/g)].map(
      ([, method, path]) => ({ method: String(method), path: `/api${String(path).replace(/:(\w+)/g, '{$1}')}` })
    )
    expect(routes.length).toBeGreaterThan(0)

    const apiOperations = Object.entries(generated.paths)
      .filter(([path]) => path.startsWith('/api/'))
      .flatMap(([path, ops]) => Object.keys(ops).map((method) => ({ method, path })))
    expect(apiOperations.length).toBeGreaterThanOrEqual(routes.length)

    for (const route of routes) {
      expect(generated.paths[route.path]?.[route.method], `${route.method.toUpperCase()} ${route.path}`).toBeDefined()
    }
  })
})
