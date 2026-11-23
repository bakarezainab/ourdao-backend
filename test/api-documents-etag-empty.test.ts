import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #262: GET /api/documents returns consistent ETags for empty result
// sets, enabling proper HTTP 304 Not Modified caching.

describe('GET /api/documents ETag on empty results (issue #262)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('returns consistent ETag header for empty document queries', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/documents' })
    expect(res1.statusCode).toBe(200)
    expect(res1.json()).toEqual([])

    const etag1 = res1.headers.etag
    expect(etag1).toBeDefined()

    const res2 = await app.inject({ method: 'GET', url: '/api/documents' })
    expect(res2.statusCode).toBe(200)
    expect(res2.json()).toEqual([])

    const etag2 = res2.headers.etag
    expect(etag2).toBeDefined()

    // ETags should match for identical empty responses
    expect(etag1).toBe(etag2)
  })

  it('returns 304 Not Modified when If-None-Match matches current ETag', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/documents' })
    expect(res1.statusCode).toBe(200)
    const etag = res1.headers.etag
    expect(etag).toBeDefined()

    const res2 = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { 'if-none-match': etag as string },
    })
    expect(res2.statusCode).toBe(304)
    expect(res2.body).toBe('')
  })

  it('returns consistent ETag for empty loan document queries', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/documents?kind=loan' })
    expect(res1.statusCode).toBe(200)
    expect(res1.json()).toEqual([])

    const etag1 = res1.headers.etag

    const res2 = await app.inject({ method: 'GET', url: '/api/documents?kind=loan' })
    expect(res2.statusCode).toBe(200)
    expect(res2.json()).toEqual([])

    const etag2 = res2.headers.etag

    expect(etag1).toBe(etag2)
  })

  it('returns consistent ETag for empty treasury document queries', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/documents?kind=treasury' })
    expect(res1.statusCode).toBe(200)
    expect(res1.json()).toEqual([])

    const etag1 = res1.headers.etag

    const res2 = await app.inject({ method: 'GET', url: '/api/documents?kind=treasury' })
    expect(res2.statusCode).toBe(200)

    const etag2 = res2.headers.etag

    expect(etag1).toBe(etag2)
  })

  it('sets appropriate Cache-Control header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/documents' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBeDefined()
    expect(res.headers['cache-control']).toMatch(/public/)
  })
})

describe('GET /api/documents with independent optional filters (issue #189)', () => {
  let app: FastifyInstance
  const MEMBER = Keypair.random().publicKey()
  const OTHER = Keypair.random().publicKey()

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  const ordered = <T extends { ledger: number; id: number }>(rows: T[]) =>
    [...rows].sort((a, b) => b.ledger - a.ledger || b.id - a.id)

  it('lists every kind and proposal with no query parameters, ordered by ledger and id descending', async () => {
    const seeded = await query<{ id: number; proposal_id: number; kind: string; ledger: number }>(
      `INSERT INTO documents (event_id, proposal_id, kind, caller, ledger) VALUES
         ('unfiltered-1', 1, 'loan', $1, 200),
         ('unfiltered-2', 4, 'treasury', $2, 300),
         ('unfiltered-3', 2, 'loan', $1, 300),
         ('unfiltered-4', 4, 'treasury', $1, 100),
         ('unfiltered-5', 9, 'loan', $2, 300)
       RETURNING id, proposal_id, kind, ledger`,
      [MEMBER, OTHER]
    )

    const res = await app.inject({ method: 'GET', url: '/api/documents' })
    expect(res.statusCode).toBe(200)
    const body = res.json<Array<{ id: number; proposal_id: number; kind: string; ledger: number }>>()
    expect(body.map(({ id, proposal_id, kind, ledger }) => ({ id, proposal_id, kind, ledger })))
      .toEqual(ordered(seeded))
    expect(new Set(body.map((document) => document.kind))).toEqual(new Set(['loan', 'treasury']))
    expect(new Set(body.map((document) => document.proposal_id))).toEqual(new Set([1, 2, 4, 9]))
  })

  it('filters by caller alone, without requiring kind or proposal_id', async () => {
    await query(
      `INSERT INTO documents (event_id, proposal_id, kind, caller, ledger) VALUES
         ('caller-1', 1, 'loan', $1, 100),
         ('caller-2', 7, 'treasury', $2, 300),
         ('caller-3', 2, 'treasury', $1, 300),
         ('caller-4', 8, 'loan', $1, 200)`,
      [MEMBER, OTHER]
    )
    const expected = await query<{ id: number; proposal_id: number; kind: string; ledger: number }>(
      'SELECT id, proposal_id, kind, ledger FROM documents WHERE caller = $1 ORDER BY ledger DESC, id DESC',
      [MEMBER]
    )

    const res = await app.inject({ method: 'GET', url: `/api/documents?caller=${MEMBER}` })
    expect(res.statusCode).toBe(200)
    const body = res.json<Array<{ id: number; proposal_id: number; kind: string; ledger: number; caller: string }>>()
    expect(body.map(({ id, proposal_id, kind, ledger }) => ({ id, proposal_id, kind, ledger }))).toEqual(expected)
    expect(body.every((document) => document.caller === MEMBER)).toBe(true)
    expect(new Set(body.map((document) => document.kind))).toEqual(new Set(['loan', 'treasury']))
  })
})
