/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ContextMeter,
  cacheHitPct,
  shouldShowContextTelemetry
} from '@renderer/features/chat/components/composer/ContextMeter'
import type { ContextUsageState } from '@shared/utils/contextUsage'

const baseUsage: ContextUsageState = {
  step: 3,
  used: 45000,
  estimatedTokens: 44000,
  inputTokens: 45000,
  window: 128000,
  contentWindow: 89600,
  compactionTrigger: 62720,
  source: 'provider',
  layers: { system: 5000, history: 32000, tools: 7000, buffer: 19200 },
  stepUsage: {
    inputTokens: 45000,
    billedInputTokens: 120000,
    peakInputTokens: 45000,
    outputTokens: 1200,
    cachedInputTokens: 20000,
    billedCachedInputTokens: 50000,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    steps: 3,
    stepsWithCacheReport: 3
  },
  updatedAt: '2026-01-01T12:00:00.000Z'
}

describe('shouldShowContextTelemetry', () => {
  it('hides when estimate equals provider input', () => {
    expect(
      shouldShowContextTelemetry({
        ...baseUsage,
        estimatedTokens: 5600,
        inputTokens: 5600,
        source: 'estimate'
      })
    ).toBe(false)
  })

  it('shows when estimate and provider differ', () => {
    expect(shouldShowContextTelemetry(baseUsage)).toBe(true)
  })

  it('shows estimate-only when no provider input', () => {
    expect(
      shouldShowContextTelemetry({
        ...baseUsage,
        inputTokens: undefined,
        source: 'estimate'
      })
    ).toBe(true)
  })
})

describe('ContextMeter', () => {
  it('opens a structured breakdown popover on click', () => {
    render(<ContextMeter usage={baseUsage} />)

    const trigger = screen.getByRole('button', { name: /context window/i })
    expect(trigger.textContent).toContain('45k')
    expect(trigger.textContent).toContain('90k')
    expect(trigger.textContent).toContain('44%')

    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: /context window breakdown/i })
    expect(dialog).toBeTruthy()
    expect(screen.getByText(/^Layers$/i)).toBeTruthy()
    expect(screen.getByText(/^Telemetry$/i)).toBeTruthy()
    expect(screen.getByText(/^Prompt cache$/i)).toBeTruthy()
    expect(screen.getAllByText(/Cache hit/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Step usage/i)).toBeTruthy()
    expect(screen.getByText(/Billed input/i)).toBeTruthy()
    expect(screen.getByText(/Compaction at/i)).toBeTruthy()
    expect(screen.getByText(/Content budget/i)).toBeTruthy()
    expect(screen.getByText(/Step 3 · 128k window/i)).toBeTruthy()
    expect(screen.getByText(/Buffer is reserved, not counted in usage/i)).toBeTruthy()
    expect(screen.queryByText(/Consumed/i)).toBeNull()
  })

  it('shows cache write when creation tokens are present without a hit', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          stepUsage: {
            ...baseUsage.stepUsage,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 8000
          }
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /context window/i }))
    expect(screen.getByText(/^Prompt cache$/i)).toBeTruthy()
    expect(screen.getByText(/^Cache write$/)).toBeTruthy()
    expect(screen.getByText(/^8k$/)).toBeTruthy()
  })

  it('hides Telemetry when estimate matches provider input', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          estimatedTokens: 5600,
          inputTokens: 5600,
          used: 5600,
          source: 'estimate'
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /context window/i }))
    expect(screen.queryByText(/^Telemetry$/i)).toBeNull()
    expect(screen.getByText(/^Estimated$/i)).toBeTruthy()
  })

  it('shows Telemetry delta when estimate and provider differ', () => {
    render(<ContextMeter usage={baseUsage} />)
    fireEvent.click(screen.getByRole('button', { name: /context window/i }))
    expect(screen.getByText(/^Telemetry$/i)).toBeTruthy()
    expect(screen.getByText(/^Delta$/i)).toBeTruthy()
    expect(screen.getByText('+1k')).toBeTruthy()
  })

  it('shows task-boundary tip when billed input or steps cross thresholds', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          stepUsage: {
            ...baseUsage.stepUsage,
            steps: 40,
            billedInputTokens: 1_200_000
          }
        }}
      />
    )
    const trigger = screen.getByRole('button', { name: /context window/i })
    expect(trigger.className).toMatch(/text-warning/)
    expect(trigger.className).toMatch(/bg-warning/)
    fireEvent.click(trigger)
    expect(screen.getByText(/Long run — \/clear/i)).toBeTruthy()
  })

  it('tones the trigger when context is past the compaction line', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          used: 70000,
          stepUsage: {
            ...baseUsage.stepUsage,
            steps: 1,
            billedInputTokens: 1000
          }
        }}
      />
    )
    const trigger = screen.getByRole('button', { name: /context window/i })
    expect(trigger.className).toMatch(/text-warning/)
    expect(trigger.className).toMatch(/bg-warning/)
  })
})

describe('cacheHitPct', () => {
  it('returns null without a hit', () => {
    expect(
      cacheHitPct({
        inputTokens: 1000,
        billedInputTokens: 1000,
        peakInputTokens: 1000,
        outputTokens: 0,
        cachedInputTokens: 0,
        billedCachedInputTokens: 0,
        cacheCreationInputTokens: 100,
        reasoningTokens: 0,
        steps: 1,
        stepsWithCacheReport: 1
      })
    ).toBeNull()
  })

  it('rounds hit share of input', () => {
    expect(
      cacheHitPct({
        inputTokens: 45000,
        billedInputTokens: 45000,
        peakInputTokens: 45000,
        outputTokens: 0,
        cachedInputTokens: 20000,
        billedCachedInputTokens: 20000,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        steps: 1,
        stepsWithCacheReport: 1
      })
    ).toBe(44)
  })
})
