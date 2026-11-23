import { beforeEach, describe, expect, it } from 'vitest'
import { pool } from '../src/db/index.js'
import { findMemberActivityHotspot } from '../src/db/member-activity-threshold.js'
import { resetDb } from './db.js'

// Stellar strkey is base32 (RFC 4648): only A-Z and 2-7 are valid, so a
// numeric suffix like '...AAA1' would (correctly) fail the hotspot query's
// address regex. Vary the last character within A-Z instead.
function address(n: number): string {
  return 'G' + 'A'.repeat(54) + String.fromCharCode(66 + n)
}

async function insertEvent(id: string, symbol: string, data: unknown[]): Promise<void> {
  await pool.query(
    `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
     VALUES ($1, 1, now(), 'CTEST', $2, $3, $4)`,
    [id, symbol, JSON.stringify([symbol]), JSON.stringify(data)]
  )
}

describe('findMemberActivityHotspot (issue #596)', () => {
  beforeEach(resetDb)

  it('returns null when events has no member-activity rows', async () => {
    expect(await findMemberActivityHotspot()).toBeNull()
  })

  it('finds the (symbol, address) pair with the most events', async () => {
    const hot = address(1)
    const other = address(2)
    // 5 'joined' events for the hot address, 2 for another.
    for (let i = 0; i < 5; i++) await insertEvent(`hot-${i}`, 'joined', [hot, 100])
    for (let i = 0; i < 2; i++) await insertEvent(`other-${i}`, 'joined', [other, 100])

    const result = await findMemberActivityHotspot()
    expect(result).toEqual({ symbol: 'joined', address: hot, eventCount: 5 })
  })

  it('ignores symbols outside MEMBER_ACTIVITY_SYMBOLS', async () => {
    const addr = address(3)
    // 'tre_prop' is not a member-activity symbol (issue #26) — more events
    // than the legitimate 'staked' rows below, but must not win.
    for (let i = 0; i < 20; i++) await insertEvent(`excluded-${i}`, 'tre_prop', [1000 + i, addr])
    for (let i = 0; i < 3; i++) await insertEvent(`staked-${i}`, 'staked', [addr, 50])

    const result = await findMemberActivityHotspot()
    expect(result).toEqual({ symbol: 'staked', address: addr, eventCount: 3 })
  })

  it('does not count a non-address tuple entry as a participant', async () => {
    // 'loan_req' = ['id', 'borrower', 'amount', 'total_repayment'] — only
    // the borrower entry should ever match the address regex.
    const borrower = address(4)
    await insertEvent('loan-1', 'loan_req', [7, borrower, '1000', '1100'])

    const result = await findMemberActivityHotspot()
    expect(result).toEqual({ symbol: 'loan_req', address: borrower, eventCount: 1 })
  })
})
