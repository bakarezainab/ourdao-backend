// Issue #584: a worker leader-election lock so a container scheduler
// rescheduling the worker (a node drain, a rolling update, an OOM kill
// followed by a replacement starting before the old one is confirmed
// stopped) can't run two poll loops concurrently against the same
// database/schema — see src/db/index.ts's acquireWorkerLeaderLock doc
// comment for why this is a distinct, longer-held lock from
// REINDEX_LOCK_KEY/MIGRATION_LOCK_KEY.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDedicatedClient,
  tryAcquireLeaderLock,
  releaseLeaderLock,
  acquireWorkerLeaderLock,
} from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('worker leader-election lock primitives (issue #584)', () => {
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(closeDb)

  it('a second acquire fails while the first lock is held, and succeeds again after a clean release', async () => {
    const first = await acquireWorkerLeaderLock()
    try {
      await expect(acquireWorkerLeaderLock()).rejects.toThrow(/leader-election lock/i)
    } finally {
      await first.release()
    }

    // Released cleanly — a fresh acquire now succeeds.
    const second = await acquireWorkerLeaderLock()
    await second.release()
  })

  it('release() is safe to call more than once', async () => {
    const lock = await acquireWorkerLeaderLock()
    await lock.release()
    await expect(lock.release()).resolves.toBeUndefined()
  })

  it('a crashed holder (connection dropped without release()) frees the lock once Postgres notices', async () => {
    const holder = createDedicatedClient()
    await holder.connect()
    expect(await tryAcquireLeaderLock(holder)).toBe(true)

    // A second, concurrent holder must be refused while the first is alive.
    const contender = createDedicatedClient()
    await contender.connect()
    try {
      expect(await tryAcquireLeaderLock(contender)).toBe(false)
    } finally {
      await contender.end()
    }

    // Simulate a crash: close the holder's connection directly, *without*
    // first running pg_advisory_unlock — exactly what a SIGKILL'd worker
    // does. Postgres frees a session-level advisory lock automatically once
    // it notices the session's connection is gone.
    await holder.end()

    const replacement = createDedicatedClient()
    await replacement.connect()
    try {
      expect(await tryAcquireLeaderLock(replacement)).toBe(true)
      await releaseLeaderLock(replacement)
    } finally {
      await replacement.end()
    }
  })
})

describe('worker leader-election lock integration with runIndexer (issue #584)', () => {
  beforeEach(async () => {
    await resetDb()
    vi.resetModules()
  })
  afterAll(closeDb)

  it('runIndexer refuses to start with a clear error while another connection already holds the lock, and starts once it is released', async () => {
    vi.doMock('../src/config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/config.js')>()
      return {
        ...actual,
        config: { ...actual.config, stellar: { ...actual.config.stellar, contractId: 'CLEADERTEST', contractIds: ['CLEADERTEST'] } },
        assertContractConfigured: () => 'CLEADERTEST',
        assertContractsConfigured: () => ['CLEADERTEST'],
      }
    })
    const getEventsMock = vi.fn().mockResolvedValue({ events: [], cursor: 'tok', latestLedger: 100 })
    vi.doMock('../src/stellar/rpc.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/stellar/rpc.js')>()
      return {
        ...actual,
        server: { getEvents: getEventsMock },
        getLatestLedger: vi.fn().mockResolvedValue(100),
        getLatestLedgerInfo: vi.fn().mockResolvedValue({ sequence: 100, hash: 'HASH_100' }),
      }
    })

    const { acquireWorkerLeaderLock: acquireLock } = await import('../src/db/index.js')
    const { runIndexer, stopIndexer } = await import('../src/indexer/poller.js')

    // Simulate another worker process already holding the lock on its own
    // connection — runIndexer()'s own `running` in-process flag is false
    // here, so only the DB-level lock can be what refuses this start.
    const other = await acquireLock()
    try {
      await expect(runIndexer()).rejects.toThrow(/leader-election lock/i)
    } finally {
      await other.release()
    }

    // With the other "worker" gone, this process can start normally.
    const run = runIndexer()
    await vi.waitFor(() => expect(getEventsMock).toHaveBeenCalled())
    await stopIndexer()
    await run
  })
})
