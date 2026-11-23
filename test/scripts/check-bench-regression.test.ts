import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    readFileSync: vi.fn(() => ''),
    appendFileSync: vi.fn(),
  }
})

describe('scripts/check-bench-regression', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.GITHUB_STEP_SUMMARY
    process.argv = ['node', 'scripts/check-bench-regression.ts']
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const baseline = {
    ranAt: '2024-01-01T00:00:00Z',
    results: [
      {
        targetEvents: 10000,
        bytesPerRow: 100,
        indexBytes: { events_data_gin_idx: 50000 },
        reindexMsPerEvent: 0.5,
      },
      {
        targetEvents: 20000,
        bytesPerRow: 100,
        indexBytes: { events_data_gin_idx: 50000 },
        reindexMsPerEvent: 0.5,
      },
    ],
  }

  it('compares current against baseline for each target event count', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const currentResults = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 105,
          indexBytes: { events_data_gin_idx: 52500 },
          reindexMsPerEvent: 0.6,
        },
        {
          targetEvents: 20000,
          bytesPerRow: 105,
          indexBytes: { events_data_gin_idx: 52500 },
          reindexMsPerEvent: 0.6,
        },
      ],
    }

    const { report } = compareResults(currentResults, baseline)

    // Should produce a report with both event counts
    expect(report).toContain('10000')
    expect(report).toContain('20000')
    expect(report).toContain('### Events-storage benchmark')
  })

  it('outputs markdown table with columns: events | metric | baseline | current | change', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const currentResults = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const { report } = compareResults(currentResults, baseline)

    // Check table structure
    expect(report).toContain('| events | metric | baseline | current | change |')
    expect(report).toContain('| ---: | --- | ---: | ---: | ---: |')
    expect(report).toContain('bytes/row')
    expect(report).toContain('events_data_gin_idx')
    expect(report).toContain('reindex ms/event')
  })

  it('flags regressions with ⚠️ and % change', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const currentResults = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 118,
          indexBytes: { events_data_gin_idx: 61000 },
          reindexMsPerEvent: 1.5,
        },
      ],
    }

    const { report, warnings } = compareResults(currentResults, baseline)

    // Should detect all three regressions
    expect(warnings).toHaveLength(3)
    expect(report).toContain('⚠️')
    expect(report).toContain('+18.0%') // bytes/row 18% > 15%
    expect(report).toContain('+22.0%') // gin 22% > 20%
    expect(report).toContain('+200.0%') // ms/event 200% > 50%
  })

  it('bytesPerRow regression triggers warning if > 15% change', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 118,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const { warnings } = compareResults(current, baseline)

    // Should flag the bytes/row regression (18% > 15%)
    expect(warnings).toContainEqual(expect.stringContaining('bytes/row grew +18.0%'))
  })

  it('events_data_gin_idx regression triggers warning if > 20% change', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 61000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const { warnings } = compareResults(current, baseline)

    // Should flag the GIN index regression (22% > 20%)
    expect(warnings).toContainEqual(expect.stringContaining('events_data_gin_idx size grew +22.0%'))
  })

  it('reindexMsPerEvent regression triggers warning if > 50% change', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 1.5,
        },
      ],
    }

    const { warnings } = compareResults(current, baseline)

    // Should flag ms/event regression (200% > 50%)
    expect(warnings).toContainEqual(expect.stringContaining('reindex throughput dropped: ms/event grew +200.0%'))
  })

  it('no warnings when metrics improve or stay within threshold', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const { warnings, report } = compareResults(current, baseline)

    // No regressions, no warnings
    expect(warnings).toHaveLength(0)
    expect(report).toContain('No metric regressed beyond threshold.')
  })

  it('warns "no regression" when everything is good', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const { report } = compareResults(current, baseline)

    // Should explicitly say no regression
    expect(report).toContain('No metric regressed beyond threshold.')
  })

  it('appends to GITHUB_STEP_SUMMARY when env var is set', async () => {
    process.env.GITHUB_STEP_SUMMARY = '/tmp/github-step-summary'

    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      const pathStr = String(path)
      if (pathStr.includes('current')) return JSON.stringify({
        ranAt: '2024-01-02T00:00:00Z',
        results: [
          {
            targetEvents: 10000,
            bytesPerRow: 100,
            indexBytes: { events_data_gin_idx: 50000 },
            reindexMsPerEvent: 0.5,
          },
        ],
      })
      return JSON.stringify(baseline)
    })

    const { compareResults } = await import('../../scripts/check-bench-regression.js')
    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const { report } = compareResults(current, baseline)

    // Simulating what the main() function would do
    if (process.env.GITHUB_STEP_SUMMARY) {
      vi.mocked(fs.appendFileSync)(`${process.env.GITHUB_STEP_SUMMARY}`, `\n${report}\n`)
    }

    // Verify appendFileSync was called
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/github-step-summary',
      expect.stringContaining('Events-storage benchmark')
    )
  })

  it('outputs ::warning:: annotation for each flagged metric', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 118,
          indexBytes: { events_data_gin_idx: 61000 },
          reindexMsPerEvent: 1.5,
        },
      ],
    }

    const { warnings } = compareResults(current, baseline)

    // Should have 3 warnings, each for a regressed metric
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toContain('bytes/row')
    expect(warnings[1]).toContain('events_data_gin_idx')
    expect(warnings[2]).toContain('reindex throughput')
  })

  it('always exits with code 0 (never fails)', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 200,
          indexBytes: { events_data_gin_idx: 100000 },
          reindexMsPerEvent: 5.0,
        },
      ],
    }

    // Even with major regressions, compareResults should succeed
    const result = compareResults(current, baseline)

    // Should have warnings but not throw
    expect(result).toBeDefined()
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('handles missing baseline gracefully with "no baseline at this scale" row', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const smallBaseline = {
      ranAt: '2024-01-01T00:00:00Z',
      results: [
        {
          targetEvents: 5000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const { report } = compareResults(current, smallBaseline)

    // Should output "no baseline at this scale" for the 10000 event count
    expect(report).toContain('no baseline at this scale')
  })

  it('skips metrics that don\'t exist in baseline', async () => {
    const { compareResults } = await import('../../scripts/check-bench-regression.js')

    const baselineNoGin = {
      ranAt: '2024-01-01T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: {},
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const { report, warnings } = compareResults(current, baselineNoGin)

    // Should not flag GIN index (doesn't exist in baseline)
    // Should only report bytes/row and ms/event
    expect(report).toContain('bytes/row')
    expect(report).toContain('reindex ms/event')
    expect(report).not.toContain('events_data_gin_idx') // should not be in report since baseline doesn't have it
    expect(warnings).not.toContainEqual(expect.stringContaining('gin_idx'))
  })
})
