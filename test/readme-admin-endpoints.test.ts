/**
 * Issues #463, #464, #465, #466: README omitted the admin mutation/audit
 * endpoints and four tables from its Database schema table.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const readme = readFileSync(`${root}/README.md`, 'utf8')

const quickRef = readme.slice(readme.indexOf('### Quick reference'), readme.indexOf('## Reconnecting'))
const adminBullets = readme.slice(readme.indexOf('**Admin:**'), readme.indexOf('**Real-time:**'))
const schemaTable = readme.slice(readme.indexOf('## Database schema'), readme.indexOf('## Event catalog'))

const endpoints = [
  'POST /api/admin/failed-events/:id/re-evaluate',
  'POST /api/admin/failed-events/batch-resolve',
  'POST /api/admin/clear-reorg',
  'GET /api/admin/audit-log',
]

describe('README documents the admin endpoints (issues #464, #465, #466)', () => {
  it.each(endpoints)('%s is in the quick-reference table and the Admin list', (endpoint) => {
    expect(quickRef).toContain(`| \`${endpoint}\` |`)
    expect(adminBullets).toContain(`- \`${endpoint}\``)
  })

  it('states the ADMIN_AUDIT_ACTIONS append-only contract', () => {
    expect(adminBullets).toMatch(/ADMIN_AUDIT_ACTIONS[\s\S]*append-only/)
  })
})

describe('README Database schema table lists every admin/auth table (issue #463)', () => {
  it.each(['admin_audit_log', 'reorg_halts', 'quarantine_state', 'auth_nonces'])('%s has a row', (table) => {
    expect(schemaTable).toMatch(new RegExp(`^\\| \`${table}\` \\|`, 'm'))
  })
})
