/**
 * Issue #601: README never documented GET /metrics as an endpoint — it only
 * appeared incidentally, once, in the Caching table's no-store row. An
 * operator or contributor reading README's API documentation top to bottom
 * would never find it.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const readme = readFileSync(`${root}/README.md`, 'utf8')

describe('README documents GET /metrics (issue #601)', () => {
  it('is in the API reference quick-reference table', () => {
    const quickRef = readme.slice(readme.indexOf('### Quick reference'), readme.indexOf('## Reconnecting'))
    expect(quickRef).toMatch(/\|\s*`GET \/metrics`\s*\|/)
  })

  it('is listed alongside /health, /ready, /version in a bulleted endpoint grouping', () => {
    const bulletSection = readme.slice(readme.indexOf('- `GET /health`'), readme.indexOf('**Members:**'))
    expect(bulletSection).toMatch(/- `GET \/metrics`/)
  })

  it("names the metrics it currently exposes", () => {
    expect(readme).toMatch(/ourdao_sse_connections\b/)
    expect(readme).toMatch(/ourdao_sse_connections_total\b/)
    expect(readme).toMatch(/ourdao_sse_messages_total\b/)
  })
})
