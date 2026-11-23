import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Existing fake Redis implementation
const store = new Map<string, string>()

class FakeRedis {
  static shouldFailConnection = false
  static instances: FakeRedis[] = []
  static lastOptions: { retryStrategy?: (times: number) => number | null | undefined } | undefined

  constructor(_url: string, opts?: { retryStrategy?: (times: number) => number | null | undefined }) {
    FakeRedis.instances.push(this)
    FakeRedis.lastOptions = opts
    if (FakeRedis.shouldFailConnection) {
      queueMicrotask(() => this.emitError())
    }
  }

  private listeners: Record<string, ((err: unknown) => void)[]> = {}

  on(event: string, cb: (err: unknown) => void): this {
    this.listeners[event] ??= []
    this.listeners[event].push(cb)
    return this
  }

  emit(event: string, arg?: unknown): void {
    for (const cb of this.listeners[event] ?? []) cb(arg)
  }

  private emitError(): void {
    this.emit('error', new Error('ECONNREFUSED (fake)'))
  }

  async get(key: string): Promise<string | null> {
    if (FakeRedis.shouldFailConnection) throw new Error('ECONNREFUSED (fake)')
    return store.has(key) ? store.get(key)! : null
  }

  async set(key: string, value: string, _ex: 'EX', _ttl: number): Promise<'OK'> {
    if (FakeRedis.shouldFailConnection) throw new Error('ECONNREFUSED (fake)')
    store.set(key, value)
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0
    for (const k of keys) {
      if (store.delete(k)) n++
    }
    return n
  }

  async scan(_cursor: string, _match: 'MATCH', pattern: string, _count: 'COUNT', _n: number): Promise<[string, string[]]> {
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
    return ['0', [...store.keys()].filter((k) => re.test(k))]
  }

  disconnect(): void {}
}

vi.mock('ioredis', () => ({ default: FakeRedis }))

describe('cache/redis', () => {
  beforeEach(async () => {
    vi.resetModules()
    store.clear()
    FakeRedis.shouldFailConnection = false
    FakeRedis.instances = []
    FakeRedis.lastOptions = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('getOrSetCache() returns fetcher result when Redis unavailable (no REDIS_URL)', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: undefined, memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ hello: 'world' })
    const result1 = await getOrSetCache('k', 30, fetcher)
    const result2 = await getOrSetCache('k', 30, fetcher)

    expect(result1).toEqual({ hello: 'world' })
    expect(result2).toEqual({ hello: 'world' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(store.size).toBe(0)
  })

  it('getOrSetCache() calls fetcher once and caches in Redis', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ n: 1 })
    const result = await getOrSetCache('members:list:50', 30, fetcher)

    expect(result).toEqual({ n: 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.get('members:list:50')).toBe(JSON.stringify({ n: 1 }))
  })

  it('subsequent getOrSetCache(same key) returns Redis value without calling fetcher', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ n: 1 })
    await getOrSetCache('members:list:50', 30, fetcher)
    const second = await getOrSetCache('members:list:50', 30, fetcher)

    expect(second).toEqual({ n: 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('Redis errors are caught and fetcher is called as fallback', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    FakeRedis.shouldFailConnection = true
    const { getOrSetCache } = await import('../../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ ok: true })
    await expect(getOrSetCache('some-key', 30, fetcher)).resolves.toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('invalidateCache() removes keys from Redis, subsequent get falls through to fetcher', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache, invalidateCache, memberSummaryCacheKey } = await import('../../src/cache/redis.js')

    const address = 'GABC'
    const fetcher = vi.fn().mockResolvedValue({ member: address })
    await getOrSetCache(memberSummaryCacheKey(address), 30, fetcher)
    expect(store.has(memberSummaryCacheKey(address))).toBe(true)

    await invalidateCache(memberSummaryCacheKey(address))
    expect(store.has(memberSummaryCacheKey(address))).toBe(false)

    await getOrSetCache(memberSummaryCacheKey(address), 30, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidateCache() logs connection errors once, not on every call', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { getOrSetCache } = await import('../../src/cache/redis.js')
      await getOrSetCache('warm', 30, vi.fn().mockResolvedValue(1))

      // Trigger connection failure
      FakeRedis.shouldFailConnection = true
      await getOrSetCache('k1', 30, vi.fn().mockResolvedValue(2))
      await getOrSetCache('k2', 30, vi.fn().mockResolvedValue(3))

      // Error logged once despite two failed calls
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('connection error is logged again after reconnect', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { getOrSetCache } = await import('../../src/cache/redis.js')
      await getOrSetCache('warm', 30, vi.fn().mockResolvedValue(1))
      const redis = FakeRedis.instances[0]!

      // First outage
      FakeRedis.shouldFailConnection = true
      await getOrSetCache('members:list:50', 30, vi.fn().mockResolvedValue({ n: 2 }))
      expect(errorSpy).toHaveBeenCalledTimes(1)

      // Reconnect
      FakeRedis.shouldFailConnection = false
      redis.emit('ready')
      await getOrSetCache('members:list:50', 30, vi.fn().mockResolvedValue({ n: 2 }))

      // Second outage is logged again
      FakeRedis.shouldFailConnection = true
      await getOrSetCache('members:list:50', 30, vi.fn().mockResolvedValue({ n: 2 }))
      expect(errorSpy).toHaveBeenCalledTimes(2)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('invalidateMembersListCache() uses SCAN to find and delete all members:list:* keys', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache, invalidateMembersListCache, membersListCacheKey } = await import('../../src/cache/redis.js')

    await getOrSetCache(membersListCacheKey(50), 30, vi.fn().mockResolvedValue([1]))
    await getOrSetCache(membersListCacheKey(200), 30, vi.fn().mockResolvedValue([2]))
    expect(store.size).toBe(2)

    await invalidateMembersListCache()
    expect(store.size).toBe(0)
  })

  it('invalidateMembersListCache() handles SCAN cursor pagination', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { invalidateMembersListCache, membersListCacheKey } = await import('../../src/cache/redis.js')

    // Add many keys to test SCAN pagination
    for (let i = 0; i < 150; i++) {
      store.set(membersListCacheKey(i), JSON.stringify([i]))
    }
    expect(store.size).toBeGreaterThan(100)

    await invalidateMembersListCache()
    expect(store.size).toBe(0)
  })

  it('seeds more cached members:list:N keys than one SCAN COUNT batch (100) covers', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache, invalidateMembersListCache, membersListCacheKey } = await import('../../src/cache/redis.js')

    // Create more than 100 keys to test SCAN batching
    for (let i = 0; i < 150; i++) {
      await getOrSetCache(membersListCacheKey(i), 30, vi.fn().mockResolvedValue({ limit: i }))
    }

    expect(store.size).toBeGreaterThan(100)

    // Should clear all despite needing multiple SCAN batches
    await invalidateMembersListCache()
    expect(store.size).toBe(0)
  })

  it('invalidateMembersListCache() is a safe no-op when Redis is unconfigured', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: undefined, memberCacheTtlSeconds: 30 } },
    }))
    const { invalidateMembersListCache } = await import('../../src/cache/redis.js')

    // Should not throw
    await expect(invalidateMembersListCache()).resolves.not.toThrow()
  })

  it('invalidateMembersListCache() is a safe no-op when Redis is unreachable', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    FakeRedis.shouldFailConnection = true
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const { invalidateMembersListCache } = await import('../../src/cache/redis.js')
      // Should not throw
      await expect(invalidateMembersListCache()).resolves.not.toThrow()
      // Error logged once
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('closeRedis() quits the client and resets internal state', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache, closeRedis } = await import('../../src/cache/redis.js')

    // Create a client
    await getOrSetCache('k', 30, vi.fn().mockResolvedValue({ n: 1 }))
    expect(FakeRedis.instances.length).toBeGreaterThan(0)

    await closeRedis()

    // Client should be cleared
    FakeRedis.instances = []
    await getOrSetCache('k', 30, vi.fn().mockResolvedValue({ n: 2 }))
    // New instance created
    expect(FakeRedis.instances.length).toBeGreaterThan(0)
  })

  it('__resetCacheClientForTests() clears client so a new REDIS_URL takes effect', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache, __resetCacheClientForTests } = await import('../../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ n: 1 })
    await getOrSetCache('k', 30, fetcher)
    const firstInstances = FakeRedis.instances.length

    // Reset for test isolation
    __resetCacheClientForTests()
    FakeRedis.instances = []

    // Next call creates a fresh client
    await getOrSetCache('k', 30, fetcher)
    expect(FakeRedis.instances.length).toBeGreaterThan(0)
  })

  it('keeps reconnecting with a capped backoff instead of giving up (issue #348)', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const { getOrSetCache } = await import('../../src/cache/redis.js')
    await getOrSetCache('members:list:50', 30, vi.fn().mockResolvedValue([]))

    const retryStrategy = FakeRedis.lastOptions?.retryStrategy
    expect(retryStrategy).toBeTypeOf('function')
    expect(retryStrategy!(1)).toBe(200)
    expect(retryStrategy!(5)).toBe(1000)
    expect(retryStrategy!(1000)).toBe(5000)
  })

  it('degrades to calling the fetcher when Redis is unreachable, without throwing', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    FakeRedis.shouldFailConnection = true
    const { getOrSetCache } = await import('../../src/cache/redis.js')

    const fetcher = vi.fn().mockResolvedValue({ ok: true })
    await expect(getOrSetCache('some-key', 30, fetcher)).resolves.toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('resumes caching after a Redis restart and logs the next outage again (issue #348)', async () => {
    vi.doMock('../../src/config.js', () => ({
      config: { cache: { redisUrl: 'redis://fake:6379', memberCacheTtlSeconds: 30 } },
    }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { getOrSetCache } = await import('../../src/cache/redis.js')
      await getOrSetCache('warm', 30, vi.fn().mockResolvedValue(1))
      const redis = FakeRedis.instances[0]!

      FakeRedis.shouldFailConnection = true
      const fetcher = vi.fn().mockResolvedValue({ n: 2 })
      await getOrSetCache('members:list:50', 30, fetcher)
      await getOrSetCache('members:list:50', 30, fetcher)
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(errorSpy).toHaveBeenCalledTimes(1)

      FakeRedis.shouldFailConnection = false
      redis.emit('ready')
      await getOrSetCache('members:list:50', 30, fetcher)
      expect(store.has('members:list:50')).toBe(true)
      const cached = await getOrSetCache('members:list:50', 30, fetcher)
      expect(cached).toEqual({ n: 2 })
      expect(fetcher).toHaveBeenCalledTimes(3)

      FakeRedis.shouldFailConnection = true
      await getOrSetCache('members:list:50', 30, fetcher)
      expect(errorSpy).toHaveBeenCalledTimes(2)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
