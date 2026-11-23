/**
 * Issue #600: the operational probe/metrics endpoints (/health, /ready,
 * /version, /metrics, /health/dependencies) previously had no schema: block
 * at all, so openapi.json rendered them as a bare
 * {"responses":{"200":{"description":"Default Response"}}} with no tag, no
 * summary, and no response schema.
 *
 * Reads openapi.json directly (like test/api-response-schemas.test.ts does
 * for the /api/* business routes) so it runs without a Postgres connection.
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPENAPI_PATH = join(__dirname, '../openapi.json')

interface OpenAPIOperation {
  tags?: string[]
  summary?: string
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>
}

interface OpenAPISpec {
  paths: Record<string, { get?: OpenAPIOperation }>
}

function readSpec(): OpenAPISpec {
  return JSON.parse(readFileSync(OPENAPI_PATH, 'utf-8')) as OpenAPISpec
}

function responseSchema(op: OpenAPIOperation | undefined, status: string): unknown {
  const content = op?.responses?.[status]?.content
  if (!content) return undefined
  const [, body] = Object.entries(content)[0] ?? []
  return body?.schema
}

describe('operational probe OpenAPI documentation (issue #600)', () => {
  const spec = readSpec()

  it.each(['/health', '/ready', '/version', '/metrics', '/health/dependencies'])(
    'GET %s has a tag, a summary, and a non-empty 200 response schema',
    (path) => {
      const op = spec.paths[path]?.get
      expect(op, `${path} has no GET operation in openapi.json`).toBeDefined()
      expect(op?.tags?.length, `${path} has no tags`).toBeGreaterThan(0)
      expect(op?.summary, `${path} has no summary`).toBeTruthy()

      const schema = responseSchema(op, '200')
      expect(schema, `${path}'s 200 response has no schema`).toBeDefined()
    }
  )

  it('/health and /ready use the health tag; /metrics uses the stats tag (matching server.ts\'s existing tag definitions)', () => {
    expect(spec.paths['/health']?.get?.tags).toContain('health')
    expect(spec.paths['/ready']?.get?.tags).toContain('health')
    expect(spec.paths['/version']?.get?.tags).toContain('health')
    expect(spec.paths['/health/dependencies']?.get?.tags).toContain('health')
    expect(spec.paths['/metrics']?.get?.tags).toContain('stats')
  })

  it("/ready documents both its 200 (ready) and 503 (not ready) shapes", () => {
    const op = spec.paths['/ready']?.get
    const ok = responseSchema(op, '200') as { properties?: Record<string, unknown> } | undefined
    const notReady = responseSchema(op, '503') as { properties?: Record<string, unknown> } | undefined

    expect(ok, "/ready has no 200 response schema").toBeDefined()
    expect(ok?.properties?.indexer, "/ready's 200 schema is missing 'indexer'").toBeDefined()
    expect(ok?.properties?.lastIndexedLedger, "/ready's 200 schema is missing 'lastIndexedLedger'").toBeDefined()

    expect(notReady, "/ready has no 503 response schema").toBeDefined()
    expect(notReady?.properties?.reason, "/ready's 503 schema is missing 'reason'").toBeDefined()
    expect(notReady?.properties?.reorg, "/ready's 503 schema is missing 'reorg' (reorg_detected shape)").toBeDefined()
  })

  it("/health/dependencies documents the per-dependency {status, latencyMs, error?} shape for postgres and rpc", () => {
    const schema = responseSchema(spec.paths['/health/dependencies']?.get, '200') as
      | { properties?: Record<string, { properties?: Record<string, unknown> }> }
      | undefined

    for (const dep of ['postgres', 'rpc']) {
      const depSchema = schema?.properties?.[dep]
      expect(depSchema, `/health/dependencies is missing the '${dep}' property`).toBeDefined()
      expect(depSchema?.properties?.status, `${dep}'s schema is missing 'status'`).toBeDefined()
      expect(depSchema?.properties?.latencyMs, `${dep}'s schema is missing 'latencyMs'`).toBeDefined()
      expect(depSchema?.properties?.error, `${dep}'s schema is missing 'error'`).toBeDefined()
    }
  })
})
