import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { closeDb, resetDb } from './db.js'

interface OpenApiSpec {
  tags: Array<{ name: string; description?: string }>
  paths: Record<string, Record<string, { tags?: string[] }>>
}

// Issue #597: every route's `tags:` must match a tag *name* declared in the
// Swagger registration (src/api/server.ts) exactly — tag matching is
// case-sensitive, so `'Events'` doesn't refer to the declared `events` tag
// at all and Swagger UI renders a second, undescribed group instead.
describe('OpenAPI tag casing (issue #597)', () => {
  let app: FastifyInstance
  let spec: OpenApiSpec

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
    spec = (app as unknown as { swagger: () => OpenApiSpec }).swagger()
  })

  afterAll(closeDb)

  it('declares every tag name in lowercase', () => {
    for (const tag of spec.tags) {
      expect(tag.name).toBe(tag.name.toLowerCase())
    }
  })

  it('every route tag matches a declared tag name exactly', () => {
    const declaredNames = new Set(spec.tags.map((t) => t.name))
    const unmatched: string[] = []
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const tag of operation.tags ?? []) {
          if (!declaredNames.has(tag)) unmatched.push(`${method.toUpperCase()} ${path} -> '${tag}'`)
        }
      }
    }
    expect(unmatched).toEqual([])
  })

  it.each([
    ['/api/members/{address}/activity', 'members'],
    ['/api/notifications', 'notifications'],
    ['/api/events', 'events'],
    ['/api/stats', 'stats'],
    ['/api/stats/history', 'stats'],
  ])('%s is tagged %s, not its capitalized form', (path, expectedTag) => {
    expect(spec.paths[path]?.get?.tags).toContain(expectedTag)
  })
})
