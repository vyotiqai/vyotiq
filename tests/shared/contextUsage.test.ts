import { describe, expect, it } from 'vitest'
import {
  contextUsageFromEvent,
  summarizeContextUsageFromEvents,
  alignContextUsageToModelWindow
} from '@shared/utils/contextUsage'

describe('contextUsage', () => {
  it('maps context_usage events into UI state', () => {
    const state = contextUsageFromEvent({
      type: 'context_usage',
      runId: 'r1',
      step: 2,
      estimatedTokens: 1200,
      inputTokens: 1100,
      contextWindow: 128000,
      contentWindow: 89600,
      compactionTrigger: 62720,
      source: 'provider',
      layers: { system: 100, history: 900, tools: 200, buffer: 19200 }
    })
    expect(state).toMatchObject({
      step: 2,
      used: 1100,
      estimatedTokens: 1200,
      window: 128000,
      contentWindow: 89600,
      source: 'provider'
    })
  })

  it('reuses prior estimate layers when provider context_usage omits them', () => {
    const prior = { system: 100, history: 900, tools: 200, buffer: 19200 }
    const state = contextUsageFromEvent(
      {
        type: 'context_usage',
        runId: 'r1',
        step: 2,
        estimatedTokens: 1200,
        inputTokens: 1100,
        contextWindow: 128000,
        contentWindow: 89600,
        compactionTrigger: 62720,
        source: 'provider'
      },
      undefined,
      prior
    )
    expect(state?.layers).toEqual(prior)
    expect(state?.source).toBe('provider')
    expect(state?.used).toBe(1100)
  })

  it('keeps prior layers when estimate context_usage omits them', () => {
    const prior = { system: 100, history: 900, tools: 200, buffer: 19200 }
    const state = contextUsageFromEvent(
      {
        type: 'context_usage',
        runId: 'r1',
        step: 2,
        estimatedTokens: 1200,
        contextWindow: 128000,
        contentWindow: 89600,
        compactionTrigger: 62720,
        source: 'estimate'
      },
      undefined,
      prior
    )
    expect(state?.layers).toEqual(prior)
    expect(state?.source).toBe('estimate')
  })

  it('replays the latest context_usage from persisted events', () => {
    const state = summarizeContextUsageFromEvents([
      {
        at: '2026-01-01T00:00:00.000Z',
        event: {
          type: 'context_usage',
          runId: 'r1',
          step: 1,
          estimatedTokens: 800,
          contextWindow: 32000,
          compactionTrigger: 20000,
          source: 'estimate',
          layers: { system: 50, history: 600, tools: 150, buffer: 4800 }
        }
      },
      {
        at: '2026-01-01T00:00:10.000Z',
        event: {
          type: 'step_usage',
          runId: 'r1',
          step: 1,
          inputTokens: 900,
          outputTokens: 40,
          cachedInputTokens: 300
        }
      },
      {
        at: '2026-01-01T00:00:20.000Z',
        event: {
          type: 'context_usage',
          runId: 'r1',
          step: 1,
          estimatedTokens: 800,
          inputTokens: 900,
          contextWindow: 32000,
          contentWindow: 22400,
          compactionTrigger: 15680,
          source: 'provider',
          layers: { system: 50, history: 600, tools: 150, buffer: 4800 }
        }
      }
    ])
    expect(state?.used).toBe(900)
    expect(state?.updatedAt).toBe('2026-01-01T00:00:20.000Z')
    expect(state?.stepUsage.outputTokens).toBe(40)
    expect(state?.stepUsage.cachedInputTokens).toBe(300)
  })

  it('keeps prior estimate layers when provider events omit them during replay', () => {
    const state = summarizeContextUsageFromEvents([
      {
        at: '2026-01-01T00:00:00.000Z',
        event: {
          type: 'context_usage',
          runId: 'r1',
          step: 1,
          estimatedTokens: 800,
          contextWindow: 32000,
          compactionTrigger: 20000,
          source: 'estimate',
          layers: { system: 50, history: 600, tools: 150, buffer: 4800 }
        }
      },
      {
        at: '2026-01-01T00:00:20.000Z',
        event: {
          type: 'context_usage',
          runId: 'r1',
          step: 1,
          estimatedTokens: 800,
          inputTokens: 900,
          contextWindow: 32000,
          contentWindow: 22400,
          compactionTrigger: 15680,
          source: 'provider'
        }
      }
    ])
    expect(state?.used).toBe(900)
    expect(state?.source).toBe('provider')
    expect(state?.layers).toEqual({ system: 50, history: 600, tools: 150, buffer: 4800 })
  })

  it('realigns stale 128k events to the real model window', () => {
    const stale = contextUsageFromEvent({
      type: 'context_usage',
      runId: 'r1',
      step: 1,
      estimatedTokens: 9000,
      inputTokens: 9000,
      contextWindow: 128000,
      contentWindow: 89600,
      compactionTrigger: 62720,
      source: 'estimate',
      layers: { system: 2000, history: 3000, tools: 4000, buffer: 19200 }
    })
    expect(stale).toBeTruthy()
    const aligned = alignContextUsageToModelWindow(stale!, 1_000_000)
    expect(aligned.window).toBe(1_000_000)
    expect(aligned.contentWindow).toBe(850_000)
    expect(aligned.layers.buffer).toBe(150_000)
    expect(aligned.used).toBe(9000)
    expect(aligned.layers.system).toBe(2000)
  })
})
