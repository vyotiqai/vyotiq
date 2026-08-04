import { describe, expect, it } from 'vitest'
import {
  COMPACTION_SOFT_CAP_TOKENS,
  TOOLS_SOFT_CAP_TOKENS,
  compactionTriggerFromRaw,
  crossesCompactionTrigger,
  toolsBudgetFromRaw
} from '../../src/shared/domain/contextBudget'

describe('compactionTriggerFromRaw soft cap', () => {
  it('caps huge windows so long tool runs compact earlier', () => {
    const trigger = compactionTriggerFromRaw(1_000_000, 0.5)
    expect(trigger).toBe(COMPACTION_SOFT_CAP_TOKENS)
    expect(trigger).toBeLessThan(Math.floor(850_000 * 0.5))
  })

  it('keeps ratio trigger for smaller windows under the soft cap', () => {
    const trigger = compactionTriggerFromRaw(64_000, 0.7)
    const expected = Math.floor(Math.floor(64_000 * 0.85) * 0.7)
    expect(expected).toBeLessThan(COMPACTION_SOFT_CAP_TOKENS)
    expect(trigger).toBe(expected)
  })
})

describe('crossesCompactionTrigger estimate headroom', () => {
  it('fires when estimate is under trigger but within 90% headroom (AppData undercount)', () => {
    const trigger = 64_000
    // aa84 step 33: estimate 62146, provider later 76443 — must compact before send
    expect(crossesCompactionTrigger(30_781, 62_146, trigger)).toBe(true)
    expect(crossesCompactionTrigger(30_781, 50_000, trigger)).toBe(false)
    expect(crossesCompactionTrigger(64_000, 50_000, trigger)).toBe(true)
  })
})

describe('toolsBudgetFromRaw soft cap', () => {
  it('caps huge windows so MCP schemas do not fill the 18% share', () => {
    const budget = toolsBudgetFromRaw(1_000_000)
    expect(budget).toBe(TOOLS_SOFT_CAP_TOKENS)
    expect(budget).toBeLessThan(Math.floor(1_000_000 * 0.18))
  })

  it('keeps share budget when under the soft cap', () => {
    const budget = toolsBudgetFromRaw(32_000)
    const share = Math.floor(32_000 * 0.18)
    expect(share).toBeLessThan(TOOLS_SOFT_CAP_TOKENS)
    expect(budget).toBe(share)
  })
})
