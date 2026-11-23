/**
 * Issue #596 — report the largest per-address-per-symbol event count among
 * MEMBER_ACTIVITY_SYMBOLS, so an operator can check whether
 * docs/member-activity-query-plan.md's documented revisit condition ("a
 * member with tens of thousands of events of one kind") has actually been
 * reached, instead of needing to manually re-run the analysis from scratch.
 *
 * Cheap enough to run periodically by hand — this is one GIN-assisted
 * aggregation over `events`, not a hot-path or per-request query:
 *
 *   DATABASE_URL=... npm run check:member-activity-threshold
 */
import { pool } from '../src/db/index.js'
import { findMemberActivityHotspot, MEMBER_ACTIVITY_EVENT_COUNT_REVISIT_THRESHOLD } from '../src/db/member-activity-threshold.js'

async function main(): Promise<void> {
  const hotspot = await findMemberActivityHotspot()

  if (!hotspot) {
    console.log('[member-activity-threshold] no member-activity events found')
  } else {
    console.log(
      `[member-activity-threshold] largest single-kind count: ${hotspot.eventCount.toLocaleString()} ` +
        `'${hotspot.symbol}' events for ${hotspot.address} ` +
        `(revisit threshold: ${MEMBER_ACTIVITY_EVENT_COUNT_REVISIT_THRESHOLD.toLocaleString()})`
    )
    if (hotspot.eventCount >= MEMBER_ACTIVITY_EVENT_COUNT_REVISIT_THRESHOLD) {
      console.warn(
        '[member-activity-threshold] threshold reached — see docs/member-activity-query-plan.md\'s ' +
          '"Candidate index" section for the index to revisit.'
      )
    }
  }

  await pool.end()
}

main().catch((err) => {
  console.error('[member-activity-threshold] failed:', err)
  process.exit(1)
})
