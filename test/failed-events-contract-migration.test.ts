import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { pool } from '../src/db/index.js'
import { closeDb } from './db.js'

describe('failed_events contract migration (issue #499)', () => {
  afterAll(closeDb)

  it('backfills existing failures from events and preserves unmatched rows', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE SCHEMA migration_contract_test')
      await client.query('SET LOCAL search_path TO migration_contract_test')
      await client.query('CREATE TABLE events (id text PRIMARY KEY, contract_id text NOT NULL)')
      await client.query('CREATE TABLE failed_events (event_id text PRIMARY KEY)')
      await client.query(`INSERT INTO events VALUES ('event-a', 'CA'), ('event-b', 'CB')`)
      await client.query(`INSERT INTO failed_events VALUES ('event-a'), ('event-b'), ('orphan')`)
      await client.query(readFileSync('src/db/migrations/0038_failed_events_contract_id.sql', 'utf8'))
      const { rows } = await client.query<{ event_id: string; contract_id: string | null }>(
        'SELECT event_id, contract_id FROM failed_events ORDER BY event_id'
      )
      expect(rows).toEqual([
        { event_id: 'event-a', contract_id: 'CA' },
        { event_id: 'event-b', contract_id: 'CB' },
        { event_id: 'orphan', contract_id: null },
      ])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
