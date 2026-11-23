import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

// Issue #608: GET /admin/audit-log pages and sorts exclusively by `id`
// (`?before=` is `id < $N`, `ORDER BY id DESC`), never `created_at` -- so
// admin_audit_log's `?admin=`/`?action=` composite indexes are keyed on
// `id`, not `created_at`. See docs/admin-audit-log-query-plan.md for the
// full measurement, including why the planner doesn't *always* pick these
// over a primary-key backward scan (a known Postgres cost-model limitation
// for a filter uncorrelated with the sort order), and why that's still the
// right index to have.
describe('admin_audit_log id-keyed indexes (issue #608)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  async function seedRealisticLog(): Promise<void> {
    // 25 admins, 8 action types, 60k rows -- smaller than
    // docs/admin-audit-log-query-plan.md's 300k measurement scale (kept
    // small here for test runtime), but the same skew, and large enough that
    // the "stale admin" scenario below still has thousands of rows to skip.
    await query(
      `INSERT INTO admin_audit_log (admin_address, action, ip_address, payload, created_at)
       SELECT
         'G' || lpad(((i % 25) + 1)::text, 55, '0'),
         (ARRAY['resolve_quarantined_event','reset_cursor','manual_reindex','clear_reorg',
                'resolve_failed_event','update_member_name','ack_discontinuity','retry_notification']
         )[1 + (i * 7) % 8],
         '10.0.' || (i % 256) || '.' || ((i / 256) % 256),
         '{}'::jsonb,
         now() - (60000 - i) * interval '1 minute'
         FROM generate_series(1, 60000) AS i`
    )
    await query('ANALYZE admin_audit_log')
  }

  it('an admin with no recent activity is still served off its own index entries, not a full-log scan', { timeout: 30000 }, async () => {
    // This admin's rows get the LOWEST ids (inserted first = oldest),
    // modeling an operator who stopped acting long ago -- the scenario
    // where a primary-key backward scan has to skip the entire log to find
    // a page's worth of matches, and the id-keyed index pays for itself.
    await query(
      `INSERT INTO admin_audit_log (admin_address, action, ip_address, payload, created_at)
       SELECT 'GSTALEADMIN00000000000000000000000000000000000000000000',
              'reset_cursor', '10.0.0.1', '{}'::jsonb,
              now() - interval '365 days' + i * interval '1 hour'
         FROM generate_series(1, 2000) AS i`
    )
    await seedRealisticLog()

    // Drop the primary key's index path out of consideration the same way
    // the route's own query would see it if the planner's pkey-backward-scan
    // estimate weren't tied with (or below) the composite index's -- forcing
    // the comparison this test actually cares about: does the id-keyed index
    // exist and would Postgres use it when it's the only efficient option.
    // Needs one dedicated connection (not the `query()` pool helper, which
    // can hand different calls to different connections) so the DROP and the
    // later ROLLBACK are the same transaction.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_pkey')
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS)
         SELECT id, admin_address, action, ip_address, payload, created_at
           FROM admin_audit_log WHERE admin_address = 'GSTALEADMIN00000000000000000000000000000000000000000000'
          ORDER BY id DESC LIMIT 50`
      )
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n')
      expect(text).toContain('admin_audit_log_admin_address_id_idx')
      expect(text).not.toMatch(/Seq Scan|Sort/)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('the old created_at-keyed composite indexes are gone -- replaced, not kept alongside', async () => {
    const indexes = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'admin_audit_log'`
    )
    const names = indexes.map((r) => r.indexname)
    expect(names).toContain('admin_audit_log_admin_address_id_idx')
    expect(names).toContain('admin_audit_log_action_id_idx')
    expect(names).not.toContain('admin_audit_log_admin_address_idx')
    expect(names).not.toContain('admin_audit_log_action_idx')
  })
})
