// Regression tests for channelMap in handlers.ts (issue #481).
//
// These tests verify:
//  - Every key in channelMap exists in EVENT_FIELDS
//  - channelMap has no duplicate keys
//  - Dead entries (loan_reject, loan_disburse) have been removed
import { describe, expect, it } from 'vitest'
import { EVENT_FIELDS } from '../src/stellar/events.js'
import { channelMap } from '../src/indexer/handlers.js'

describe('channelMap regression tests (issue #481)', () => {
  it('every key in channelMap is a valid event symbol in EVENT_FIELDS', () => {
    const eventSymbols = Object.keys(EVENT_FIELDS)
    for (const symbol of Object.keys(channelMap)) {
      expect(eventSymbols).toContain(symbol)
    }
  })

  it('channelMap has no duplicate keys', () => {
    const keys = Object.keys(channelMap)
    const uniqueKeys = new Set(keys)
    expect(keys.length).toBe(uniqueKeys.size)
  })

  it('dead entries loan_reject and loan_disburse have been removed from channelMap', () => {
    expect('loan_reject' in channelMap).toBe(false)
    expect('loan_disburse' in channelMap).toBe(false)
  })

  it('all expected event symbols are present in channelMap', () => {
    // These are the events that are actually handled (have fold functions in handlers.ts)
    const expectedSymbols = [
      'joined', 'exited', 'staked', 'unstaked', 'claimed', 'name_reg',
      'loan_req', 'loan_edit', 'loan_vote', 'loan_wait', 'loan_rej', 'loan_appr', 'loan_exp', 'loan_rpy', 'loan_dflt',
      'tre_prop', 'tre_vote', 'committed', 'revealed', 'tre_exec', 'tre_wait', 'tre_rej',
      'interest',
      'doc_attn',
    ]
    for (const symbol of expectedSymbols) {
      expect(symbol in channelMap).toBe(true)
    }
  })
})
