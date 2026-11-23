import { afterEach, describe, expect, it, vi } from 'vitest'

// Issue #478: the LOG_LEVEL-gated logger (src/lib/logger.ts) reads LOG_LEVEL at
// import time, so each case re-imports it with a fresh module registry.
const ALL = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const

async function emittedLevels(level: string | undefined): Promise<string[]> {
  vi.resetModules()
  if (level === undefined) vi.stubEnv('LOG_LEVEL', '')
  else vi.stubEnv('LOG_LEVEL', level)
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const { logger } = await import('../src/lib/logger.js')
  for (const l of ALL) logger[l](`msg-${l}`)
  const levels = spy.mock.calls.map((c) => JSON.parse(String(c[0])).level as string)
  spy.mockRestore()
  return levels
}

describe('src/lib/logger.ts LOG_LEVEL gating', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('defaults to info: debug and trace are suppressed', async () => {
    expect(await emittedLevels(undefined)).toEqual(['fatal', 'error', 'warn', 'info'])
  })

  it('LOG_LEVEL=info suppresses debug and trace', async () => {
    expect(await emittedLevels('info')).toEqual(['fatal', 'error', 'warn', 'info'])
  })

  it('LOG_LEVEL=silent suppresses every level', async () => {
    expect(await emittedLevels('silent')).toEqual([])
  })

  it('LOG_LEVEL=trace allows every level', async () => {
    expect(await emittedLevels('trace')).toEqual([...ALL])
  })

  it('emits valid JSON with level, message, time and extra fields', async () => {
    vi.resetModules()
    vi.stubEnv('LOG_LEVEL', 'info')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { logger } = await import('../src/lib/logger.js')
    logger.warn('hello', { eventId: 'e1', count: 2 })
    expect(spy).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(spy.mock.calls[0]?.[0]))
    expect(line.level).toBe('warn')
    expect(line.message).toBe('hello')
    expect(typeof line.time).toBe('string')
    expect(Number.isNaN(Date.parse(line.time))).toBe(false)
    expect(line.eventId).toBe('e1')
    expect(line.count).toBe(2)
  })
})
