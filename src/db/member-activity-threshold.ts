import { pool } from './index.js'
import { MEMBER_ACTIVITY_SYMBOLS } from '../stellar/events.js'

/**
 * Issue #596: docs/member-activity-query-plan.md's "no migration needed"
 * conclusion names the condition under which it should be revisited — "a
 * member with tens of thousands of events of one kind" — but nothing
 * measured that condition. This is the threshold that measurement checks
 * against.
 */
export const MEMBER_ACTIVITY_EVENT_COUNT_REVISIT_THRESHOLD = 10_000

export interface MemberActivityHotspot {
  symbol: string
  address: string
  eventCount: number
}

/**
 * Finds the largest per-address-per-symbol event count among
 * `MEMBER_ACTIVITY_SYMBOLS` — a concrete answer to "is any single member
 * approaching the doc's named threshold for one kind of event".
 *
 * `GET /api/members/:address/activity` matches an address with JSONB
 * containment (`data @> '"G…"'`) because the address sits at a different
 * tuple offset per symbol (see MEMBER_ACTIVITY_SYMBOLS); this mirrors that
 * by unnesting `data` and keeping only elements shaped like a Stellar
 * address, rather than needing a fixed offset per symbol or a join against
 * `members`.
 */
export async function findMemberActivityHotspot(): Promise<MemberActivityHotspot | null> {
  const { rows } = await pool.query<{ symbol: string; address: string; event_count: string }>(
    `SELECT symbol, addr AS address, count(*) AS event_count
       FROM events, jsonb_array_elements_text(data) AS addr
      WHERE symbol = ANY($1)
        AND addr ~ '^G[A-Z2-7]{55}$'
      GROUP BY symbol, addr
      ORDER BY event_count DESC
      LIMIT 1`,
    [MEMBER_ACTIVITY_SYMBOLS as unknown as string[]]
  )
  const row = rows[0]
  if (!row) return null
  return { symbol: row.symbol, address: row.address, eventCount: Number.parseInt(row.event_count, 10) }
}
