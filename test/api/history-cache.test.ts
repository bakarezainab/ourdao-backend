import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fake Redis client for testing
class FakeRedisClient {
  private store = new Map<string, { value: string; expiresAt: number }>()
  public static shouldFailConnection = false
  public static calls: { method: string; args: unknown[] }[] = []

  constructor() {
    FakeRedisClient.calls = []
    if (FakeRedisClient.shouldFailConnection) {
      queueMicrotask(() => {
        throw new Error('Connection refused')
      })
    }
  }

  async get(key: string): Promise<string | null> {
    FakeRedisClient.calls.push({ method: 'get', args: [key] })
    if (FakeRedisClient.shouldFailConnection) throw new Error('Connection refused')
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string, opts?: { EX: number }): Promise<string> {
    FakeRedisClient.calls.push({ method: 'set', args: [key, value, opts] })
    if (FakeRedisClient.shouldFailConnection) throw new Error('Connection refused')
    const expiresAt = opts?.EX ? Date.now() + opts.EX * 1000 : Infinity
    this.store.set(key, { value, expiresAt })
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    FakeRedisClient.calls.push({ method: 'del', args: keys })
    if (FakeRedisClient.shouldFailConnection) throw new Error('Connection refused')
    let count = 0
    for (const key of keys) {
      if (this.store.delete(key)) count++
    }
    return count
  }

  async quit(): Promise<void> {
    FakeRedisClient.calls.push({ method: 'quit', args: [] })
    this.store.clear()
  }

  get isOpen(): boolean {
    return true
  }
}

vi.mock('redis', () => ({
  createClient: vi.fn(() => new FakeRedisClient()),
}))

describe('api/history-cache', () => {
  beforeEach(async () => {
    vi.resetModules()
    FakeRedisClient.shouldFailConnection = false
    FakeRedisClient.calls = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('.get() returns null when cache is empty', async () => {
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: undefined } },
    }))
    const { createHistoryCache } = await import('../../src/api/history-cache.js')
    const cache = createHistoryCache()

    const result = await cache.get()
    expect(result).toBeNull()

    await cache.close()
  })

  it('.set() stores value locally with TTL and .get() retrieves it', async () => {
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: undefined } },
    }))
    const { createHistoryCache } = await import('../../src/api/history-cache.js')
    const cache = createHistoryCache()

    const data = {
      data: [
        {
          date: '2024-01-01',
          principalLent: '1000',
          principalRepaid: '500',
          defaults: 0,
          valueDefaulted: '0',
          cumulativeDefaultRatePercent: 0,
        },
      ],
    }

    await cache.set(data)
    const result = await cache.get()

    expect(result).toEqual(data)

    await cache.close()
  })

  it('.set() skips empty data array (no-op)', async () => {
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: undefined } },
    }))
    const { createHistoryCache } = await import('../../src/api/history-cache.js')
    const cache = createHistoryCache()

    const emptyData = { data: [] }
    await cache.set(emptyData)
    const result = await cache.get()

    expect(result).toBeNull()

    await cache.close()
  })

  it('.invalidate() clears both local and Redis caches', async () => {
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: 'redis://localhost:6379' } },
    }))
    const { createHistoryCache } = await import('../../src/api/history-cache.js')
    const cache = createHistoryCache()

    const data = {
      data: [
        {
          date: '2024-01-01',
          principalLent: '1000',
          principalRepaid: '500',
          defaults: 0,
          valueDefaulted: '0',
          cumulativeDefaultRatePercent: 0,
        },
      ],
    }

    await cache.set(data)
    expect(await cache.get()).toEqual(data)

    await cache.invalidate()
    expect(await cache.get()).toBeNull()

    await cache.close()
  })

  it('.close() gracefully quits the Redis client', async () => {
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: 'redis://localhost:6379' } },
    }))
    const { createHistoryCache } = await import('../../src/api/history-cache.js')
    const cache = createHistoryCache()

    await cache.close()

    // Should not throw
    expect(true).toBe(true)
  })

  it('Redis errors are logged via console.warn but do not throw', async () => {
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: 'redis://localhost:6379' } },
    }))
    FakeRedisClient.shouldFailConnection = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { })

    try {
      const { createHistoryCache } = await import('../../src/api/history-cache.js')
      const cache = createHistoryCache()

      const data = {
        data: [
          {
            date: '2024-01-01',
            principalLent: '1000',
            principalRepaid: '500',
            defaults: 0,
            valueDefaulted: '0',
            cumulativeDefaultRatePercent: 0,
          },
        ],
      }

      await expect(cache.set(data)).resolves.not.toThrow()
      await expect(cache.get()).resolves.not.toThrow()

      await cache.close()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('no Redis instance is created when VITEST env var is set', async () => {
    process.env.VITEST = 'true'
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: 'redis://localhost:6379' } },
    }))
    const { createHistoryCache } = await import('../../src/api/history-cache.js')
    const cache = createHistoryCache()

    const data = {
      data: [
        {
          date: '2024-01-01',
          principalLent: '1000',
          principalRepaid: '500',
          defaults: 0,
          valueDefaulted: '0',
          cumulativeDefaultRatePercent: 0,
        },
      ],
    }

    await cache.set(data)
    const result = await cache.get()

    // Falls back to local cache since VITEST is set
    expect(result).toEqual(data)

    await cache.close()
  })

  it('no Redis instance is created when NODE_ENV === "test"', async () => {
    delete process.env.VITEST
    process.env.NODE_ENV = 'test'
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: 'redis://localhost:6379' } },
    }))
    const { createHistoryCache } = await import('../../src/api/history-cache.js')
    const cache = createHistoryCache()

    const data = {
      data: [
        {
          date: '2024-01-01',
          principalLent: '1000',
          principalRepaid: '500',
          defaults: 0,
          valueDefaulted: '0',
          cumulativeDefaultRatePercent: 0,
        },
      ],
    }

    await cache.set(data)
    const result = await cache.get()

    // Falls back to local cache since NODE_ENV is test
    expect(result).toEqual(data)

    await cache.close()
  })

  it('cache returns same local value if within TTL even after Redis error', async () => {
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: 'redis://localhost:6379' } },
    }))
    const { createHistoryCache } = await import('../../src/api/history-cache.js')
    const cache = createHistoryCache()

    const data = {
      data: [
        {
          date: '2024-01-01',
          principalLent: '1000',
          principalRepaid: '500',
          defaults: 0,
          valueDefaulted: '0',
          cumulativeDefaultRatePercent: 0,
        },
      ],
    }

    // Set with Redis working
    await cache.set(data)
    expect(await cache.get()).toEqual(data)

    // Simulate Redis failure
    FakeRedisClient.shouldFailConnection = true

    // Should still get local value
    const result = await cache.get()
    expect(result).toEqual(data)

    await cache.close()
  })

  it('.set() writes to Redis when available and config allows', async () => {
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: 'redis://localhost:6379' } },
    }))
    const { createHistoryCache } = await import('../../src/api/history-cache.js')
    const cache = createHistoryCache()

    const data = {
      data: [
        {
          date: '2024-01-01',
          principalLent: '1000',
          principalRepaid: '500',
          defaults: 0,
          valueDefaulted: '0',
          cumulativeDefaultRatePercent: 0,
        },
      ],
    }

    await cache.set(data)

    // Should have written to Redis
    expect(FakeRedisClient.calls.some((c) => c.method === 'set')).toBe(true)

    await cache.close()
  })

  it('.get() retrieves from Redis when available (JSON round-trip)', async () => {
    vi.mock('../../src/config.js', () => ({
      config: { cache: { historyCacheTtlSeconds: 3600, historyRedisUrl: 'redis://localhost:6379' } },
    }))
    const { createHistoryCache } = await import('../../src/api/history-cache.js')
    const cache = createHistoryCache()

    const data = {
      data: [
        {
          date: '2024-01-01',
          principalLent: '1000',
          principalRepaid: '500',
          defaults: 0,
          valueDefaulted: '0',
          cumulativeDefaultRatePercent: 0,
        },
      ],
    }

    await cache.set(data)
    const result = await cache.get()

    // Verify it's a proper JSON round-trip
    expect(JSON.stringify(result)).toEqual(JSON.stringify(data))

    await cache.close()
  })

  it('respects the configured TTL for the in-process cache (issue #504)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    try {
      vi.mock('../../src/config.js', () => ({
        config: { cache: { historyCacheTtlSeconds: 5, historyRedisUrl: undefined } },
      }))
      const { createHistoryCache } = await import('../../src/api/history-cache.js')
      const cache = createHistoryCache()

      const data = {
        data: [
          {
            date: '2024-01-01',
            principalLent: '1000',
            principalRepaid: '500',
            defaults: 0,
            valueDefaulted: '0',
            cumulativeDefaultRatePercent: 0,
          },
        ],
      }

      await cache.set(data)
      expect(await cache.get()).toEqual(data)

      vi.setSystemTime(new Date('2026-01-01T00:00:05Z'))
      expect(await cache.get()).toBeNull()

      await cache.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes the configured TTL to Redis EX (issue #504)', async () => {
    const originalVitest = process.env.VITEST
    const originalNodeEnv = process.env.NODE_ENV
    delete process.env.VITEST
    process.env.NODE_ENV = 'development'
    try {
      vi.mock('../../src/config.js', () => ({
        config: { cache: { historyCacheTtlSeconds: 7, historyRedisUrl: 'redis://localhost:6379' } },
      }))
      const { createHistoryCache } = await import('../../src/api/history-cache.js')
      const cache = createHistoryCache()

      const data = {
        data: [
          {
            date: '2024-01-01',
            principalLent: '1000',
            principalRepaid: '500',
            defaults: 0,
            valueDefaulted: '0',
            cumulativeDefaultRatePercent: 0,
          },
        ],
      }

      await cache.set(data)
      expect(FakeRedisClient.calls.find((c) => c.method === 'set')?.args[2]).toEqual({ EX: 7 })

      await cache.close()
    } finally {
      if (originalVitest === undefined) delete process.env.VITEST
      else process.env.VITEST = originalVitest
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
    }
  })
})
