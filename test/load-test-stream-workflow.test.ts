import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('scheduled SSE stream load workflow (issue #497)', () => {
  it('runs the real load script against Postgres and publishes measured results', () => {
    const workflow = readFileSync('.github/workflows/load-test-stream.yml', 'utf8')
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron:/)
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('image: postgres:16-alpine')
    expect(workflow).toContain("RATE_LIMIT_MAX: '1000'")
    expect(workflow).toContain('run: npm run migrate')
    expect(workflow).toContain('run: ./scripts/load-test-stream.sh 2>&1 | tee stream-load.log')
    expect(workflow).toContain('if: always()')
    expect(workflow).toContain('RSS growth')
    expect(workflow).toContain('Connections opened')
  })
})
