/**
 * Freeze-style regression invariants from docs/research/token-cost-jun-aug-2026
 * (session 80bd4074: compaction soft-cap trigger + cumulative billed Σ semantics).
 * Do not weaken these without an explicit product decision.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPACTION_SOFT_CAP_TOKENS,
  TOOLS_SOFT_CAP_TOKENS,
  MCP_PIN_IDLE_TTL_STEPS,
  MCP_PINNED_SOFT_MAX,
  compactionTriggerFromRaw,
  toolsBudgetFromRaw
} from '../../src/shared/domain/contextBudget'
import {
  mergeStepUsageTotals,
  stepUsageFromEvent,
  stepUsageTotalsFromPersistedEvents
} from '../../src/shared/utils/runTelemetry'

describe('token-cost freeze invariants', () => {
  it('keeps 1M-window compaction trigger at the soft cap (not ratio×content)', () => {
    const trigger = compactionTriggerFromRaw(1_000_000, 0.5)
    expect(trigger).toBe(COMPACTION_SOFT_CAP_TOKENS)
    expect(trigger).toBe(64_000)
  })

  it('keeps tools budget soft-capped on huge windows', () => {
    expect(toolsBudgetFromRaw(1_000_000)).toBe(TOOLS_SOFT_CAP_TOKENS)
  })

  it('keeps MCP pin idle TTL and soft max (unload, not immortal sticky pins)', () => {
    // Tuned from AppData 80bd4074 (read/terminal-heavy gaps between MCP uses).
    expect(MCP_PIN_IDLE_TTL_STEPS).toBe(16)
    expect(MCP_PINNED_SOFT_MAX).toBe(12)
    expect(MCP_PIN_IDLE_TTL_STEPS).toBeGreaterThan(0)
    expect(MCP_PINNED_SOFT_MAX).toBeGreaterThan(0)
  })

  it('treats billed input as Σ step inputs, not latest window', () => {
    // Shape from AppData: many ~30–45k steps → multi-million billed, peak ≪ billed.
    const steps = [30_000, 42_000, 47_049, 40_000, 35_000]
    let totals = stepUsageFromEvent({
      type: 'step_usage',
      runId: 'freeze',
      step: 1,
      inputTokens: steps[0],
      outputTokens: 100
    })!
    for (let i = 1; i < steps.length; i++) {
      const next = stepUsageFromEvent({
        type: 'step_usage',
        runId: 'freeze',
        step: i + 1,
        inputTokens: steps[i],
        outputTokens: 50
      })!
      totals = mergeStepUsageTotals(totals, next)
    }
    const sum = steps.reduce((a, b) => a + b, 0)
    expect(totals.billedInputTokens).toBe(sum)
    expect(totals.peakInputTokens).toBe(47_049)
    expect(totals.inputTokens).toBe(35_000)
    expect(totals.peakInputTokens).toBeLessThan(totals.billedInputTokens)
    expect(totals.peakInputTokens).toBeLessThanOrEqual(COMPACTION_SOFT_CAP_TOKENS)
  })

  it('rebuilds billed Σ from durable inputTokens and ignores carried billed fields', () => {
    const totals = stepUsageTotalsFromPersistedEvents([
      {
        event: {
          type: 'step_usage',
          runId: 'r',
          step: 1,
          inputTokens: 47_049,
          billedInputTokens: 9_999_999
        }
      },
      {
        event: {
          type: 'step_usage',
          runId: 'r',
          step: 2,
          inputTokens: 40_000,
          billedInputTokens: 1
        }
      }
    ])
    expect(totals.billedInputTokens).toBe(87_049)
    expect(totals.peakInputTokens).toBe(47_049)
  })
})
