import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  assertContractConfigured,
  bool,
  int,
  nonceStore,
  parseContractIds,
  parseStellarRpcHeaders,
  positiveInt,
  resolveConfig,
  str,
} from '../src/config.js'

describe('config helpers', () => {
  it('str uses the fallback only for missing or empty values', () => {
    expect(str({}, 'MISSING', 'fallback')).toBe('fallback')
    expect(str({ VALUE: '' }, 'VALUE', 'fallback')).toBe('fallback')
    expect(str({ VALUE: 'configured' }, 'VALUE', 'fallback')).toBe('configured')
  })

  it('int uses the fallback for missing, empty, malformed, and non-integer values', () => {
    expect(int({}, 'MISSING', 7)).toBe(7)
    expect(int({ VALUE: '' }, 'VALUE', 7)).toBe(7)
    expect(int({ VALUE: 'not-a-number' }, 'VALUE', 7)).toBe(7)
    expect(int({ VALUE: '12ms' }, 'VALUE', 7)).toBe(7)
    expect(int({ VALUE: '1.5' }, 'VALUE', 7)).toBe(7)
    expect(int({ VALUE: '42' }, 'VALUE', 7)).toBe(42)
    expect(int({ VALUE: '-3' }, 'VALUE', 7)).toBe(-3)
  })

  it('positiveInt keeps positive integers and falls back with a warning for zero/negative (issue #504)', () => {
    expect(positiveInt({}, 'MISSING', 3600)).toBe(3600)
    expect(positiveInt({ TTL: '60' }, 'TTL', 3600)).toBe(60)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(positiveInt({ TTL: '0' }, 'TTL', 3600)).toBe(3600)
      expect(positiveInt({ TTL: '-5' }, 'TTL', 3600)).toBe(3600)
      expect(positiveInt({ TTL: 'nope' }, 'TTL', 3600)).toBe(3600)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('bool uses the fallback for missing and empty values and recognizes true/1', () => {
    expect(bool({}, 'MISSING')).toBe(false)
    expect(bool({ VALUE: '' }, 'VALUE', true)).toBe(true)
    expect(bool({ VALUE: 'true' }, 'VALUE')).toBe(true)
    expect(bool({ VALUE: '1' }, 'VALUE')).toBe(true)
    expect(bool({ VALUE: 'false' }, 'VALUE', true)).toBe(false)
    expect(bool({ VALUE: 'unexpected' }, 'VALUE', true)).toBe(false)
  })

  it('nonceStore accepts postgres/memory (any case, trimmed) and falls back with a warning otherwise (issue #118)', () => {
    expect(nonceStore({}, 'NONCE_STORE')).toBe('postgres')
    expect(nonceStore({ NONCE_STORE: '' }, 'NONCE_STORE')).toBe('postgres')
    expect(nonceStore({ NONCE_STORE: 'memory' }, 'NONCE_STORE')).toBe('memory')
    expect(nonceStore({ NONCE_STORE: ' Postgres ' }, 'NONCE_STORE')).toBe('postgres')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(nonceStore({ NONCE_STORE: 'redis' }, 'NONCE_STORE')).toBe('postgres')
      expect(nonceStore({ NONCE_STORE: 'typo' }, 'NONCE_STORE', 'memory')).toBe('memory')
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('parseStellarRpcHeaders (#284)', () => {
  it('returns an empty object when unset or empty', () => {
    expect(parseStellarRpcHeaders(undefined)).toEqual({})
    expect(parseStellarRpcHeaders('')).toEqual({})
    expect(parseStellarRpcHeaders('   ')).toEqual({})
  })

  it('parses a single Name:Value header', () => {
    expect(parseStellarRpcHeaders('X-API-Key:abc123')).toEqual({ 'X-API-Key': 'abc123' })
  })

  it('parses multiple comma-separated headers, trimming whitespace', () => {
    expect(parseStellarRpcHeaders(' X-API-Key : abc123 , Authorization:Bearer xyz ')).toEqual({
      'X-API-Key': 'abc123',
      Authorization: 'Bearer xyz',
    })
  })

  it('treats only the first colon as the name/value separator', () => {
    expect(parseStellarRpcHeaders('Authorization:Bearer abc:def:ghi')).toEqual({
      Authorization: 'Bearer abc:def:ghi',
    })
  })

  it('skips a malformed entry with no colon and warns, keeping valid entries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseStellarRpcHeaders('X-API-Key:abc123,not-a-header,Authorization:Bearer xyz')).toEqual({
        'X-API-Key': 'abc123',
        Authorization: 'Bearer xyz',
      })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('skips an entry with an empty header name and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseStellarRpcHeaders(':no-name')).toEqual({})
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps a colon inside the value and skips malformed entries among padded ones (#489)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseStellarRpcHeaders('Authorization:Bearer abc:def')).toEqual({ Authorization: 'Bearer abc:def' })
      expect(parseStellarRpcHeaders('  X-API-Key :  k1  ,  : empty-name ,  junk  ,  Authorization  :  Bearer abc:def  ')).toEqual({
        'X-API-Key': 'k1',
        Authorization: 'Bearer abc:def',
      })
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('resolveConfig', () => {
  it('matches every documented default', () => {
    const resolved = resolveConfig({})
    expect(resolved).toEqual({
      http: {
        port: 4000,
        host: '0.0.0.0',
        corsOrigin: 'http://localhost:3000',
        rateLimitMax: 100,
        rateLimitWindowMs: 60000,
        rateLimitEventsMax: 30,
        trustProxy: 'false',
        statsCacheMs: 5000,
        statsMaxConcurrent: 1,
        statsRetryAfterSeconds: 1,
        streamMaxConnections: 100,
        streamMaxConnectionsPerIp: 10,
        streamIdleTimeoutMs: 60000,
        streamRetryAfterSeconds: 30,
        logLevel: 'info',
        readyCheckTimeoutMs: 3000,
        bodyLimitBytes: 16384,
        requestTimeoutMs: 30000,
        connectionTimeoutMs: 60000,
        keepAliveTimeoutMs: 72000,
      },
      db: {
        connectionString: undefined,
        nonceStore: 'postgres',
        nonceTtlMs: 300000,
        nonceMaxEntries: 10000,
        nonceSweepIntervalMs: 60000,
        poolMax: 10,
        statementTimeoutMs: 10000,
        connectionTimeoutMs: 5000,
        idleTimeoutMs: 30000,
        applicationName: 'ourdao-api',
        migrationLockTimeoutMs: 30000,
      },
      stellar: {
        contractId: '',
        contractIds: [],
  parseContractIds,
  parseStellarRpcHeaders,
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
        ledgerCloseTimeSeconds: 5,
      },
      indexer: {
        startLedger: 0,
        startLookbackLedgers: 17280,
        pollIntervalMs: 5000,
        pageLimit: 100,
        maxBackoffMs: 60000,
        maxDrainPages: 20,
        maxDrainMs: 30000,
        staleAfterMs: 120000,
        quarantineAfterFailures: 3,
        resetOnContractChange: false,
      },
      cache: {
        redisUrl: undefined,
        memberCacheTtlSeconds: 30,
        historyCacheTtlSeconds: 3600,
        historyRedisUrl: undefined,
      },
      workerDiagnostics: {
        host: '127.0.0.1',
        port: 4010,
      },
      maintenance: {
        intervalMs: 7 * 24 * 60 * 60 * 1000,
      },
      otel: {
        enabled: false,
        exporterOtlpEndpoint: 'http://localhost:4318/v1/traces',
        serviceName: 'ourdao-backend',
      },
    })
  })

  it('resolves HISTORY_CACHE_TTL_SECONDS, defaulting to 3600 seconds (issue #504)', () => {
    expect(resolveConfig({}).cache.historyCacheTtlSeconds).toBe(3600)
    expect(resolveConfig({ HISTORY_CACHE_TTL_SECONDS: '120' }).cache.historyCacheTtlSeconds).toBe(120)
    expect(resolveConfig({ HISTORY_CACHE_TTL_SECONDS: '0' }).cache.historyCacheTtlSeconds).toBe(3600)
  })

  it('resolves supplied values and falls back from malformed integers', () => {
    const resolved = resolveConfig({
      PORT: '4100',
      HOST: '127.0.0.1',
      CORS_ORIGIN: ' https://app.example ',
      DATABASE_URL: 'postgres://example',
      CONTRACT_ID: 'C123',
      POLL_INTERVAL_MS: 'bad',
      INDEXER_RESET_ON_CONTRACT_CHANGE: '1',
      STELLAR_LEDGER_CLOSE_TIME_SECONDS: '6',
      DB_POOL_MAX: '25',
    })
    expect(resolved.http.port).toBe(4100)
    expect(resolved.http.host).toBe('127.0.0.1')
    expect(resolved.http.corsOrigin).toBe('https://app.example')
    expect(resolved.db.connectionString).toBe('postgres://example')
    expect(resolved.stellar.contractId).toBe('C123')
    expect(resolved.indexer.pollIntervalMs).toBe(5000)
    expect(resolved.indexer.resetOnContractChange).toBe(true)
    expect(resolved.stellar.ledgerCloseTimeSeconds).toBe(6)
    expect(resolved.db.poolMax).toBe(25)
  })

  it('falls back to postgres and warns when NONCE_STORE is unrecognized (issue #118)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const resolved = resolveConfig({ NONCE_STORE: 'redis' })
      expect(resolved.db.nonceStore).toBe('postgres')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('assertContractConfigured', () => {
  it('throws the documented error when CONTRACT_ID is missing', () => {
    expect(() => assertContractConfigured(resolveConfig({}))).toThrow(
      'CONTRACT_ID is not set. The indexer needs the deployed OurDAO contract id to poll events.'
    )
  })

  it('returns the configured contract id', () => {
    expect(assertContractConfigured(resolveConfig({ CONTRACT_ID: 'C123' }))).toBe('C123')
  })
})

describe('.env.example completeness (issue #226)', () => {
  it('documents every environment variable read by src/config.ts', () => {
    const root = resolve(import.meta.dirname, '..')
    const configSource = readFileSync(resolve(root, 'src/config.ts'), 'utf8')
    const envExample = readFileSync(resolve(root, '.env.example'), 'utf8')
    const helperReads = [...configSource.matchAll(/\b(?:int|str|bool|logLevel|nonceStore)\(env,\s*'([A-Z0-9_]+)'/g)].map(
      (m) => m[1]!
    )
    const directReads = [...configSource.matchAll(/\benv\.([A-Z0-9_]+)\b/g)].map((m) => m[1]!)
    const allConfigVars = [...new Set([...helperReads, ...directReads])]
    expect(allConfigVars.length).toBeGreaterThan(0)
    const definedInExample = new Set(
      [...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]!)
    )
    const missing = allConfigVars.filter((name) => !definedInExample.has(name))
    expect(missing).toEqual([])
  })
})

describe('parseContractIds (issue #375)', () => {
  it('returns an empty array when unset', () => {
    expect(parseContractIds(undefined)).toEqual([])
  })
  it('returns an empty array for a blank string', () => {
    expect(parseContractIds('')).toEqual([])
    expect(parseContractIds('   ')).toEqual([])
  })
  it('parses a single contract id', () => {
    expect(parseContractIds('CABC')).toEqual(['CABC'])
  })
  it('parses a comma-separated list', () => {
    expect(parseContractIds('CA,CB,CC')).toEqual(['CA', 'CB', 'CC'])
  })
  it('trims whitespace around each id', () => {
    expect(parseContractIds(' CA , CB , CC ')).toEqual(['CA', 'CB', 'CC'])
  })
  it('drops empty entries', () => {
    expect(parseContractIds('CA,,CB,')).toEqual(['CA', 'CB'])
  })
  it('de-duplicates identical ids', () => {
    expect(parseContractIds('CA,CB,CA')).toEqual(['CA', 'CB'])
  })
  it('resolveConfig reads CONTRACT_IDS into contractIds', () => {
    const resolved = resolveConfig({ CONTRACT_IDS: 'CA,CB' })
    expect(resolved.stellar.contractIds).toEqual(['CA', 'CB'])
  })
  it('resolveConfig defaults contractIds to empty array when CONTRACT_IDS is unset', () => {
    const resolved = resolveConfig({ CONTRACT_ID: 'CA' })
    expect(resolved.stellar.contractIds).toEqual([])
  })
})
