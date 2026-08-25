import { describe, expect, it } from 'vitest'
import {
  loopStopDecision,
  MAX_IDENTICAL_STEP_STREAK,
  nextIdenticalStepStreak,
  stepToolCallsFingerprint
} from '@main/agent/loopPolicy'

describe('loop safety policy', () => {
  it('fingerprints a step by tool name + args', () => {
    const a = stepToolCallsFingerprint([{ name: 'read', arguments: '{"path":"a.ts"}' }])
    expect(a).toBe(stepToolCallsFingerprint([{ name: 'read', arguments: '{"path":"a.ts"}' }]))
    expect(a).not.toBe(stepToolCallsFingerprint([{ name: 'read', arguments: '{"path":"b.ts"}' }]))
    expect(a).not.toBe(stepToolCallsFingerprint([{ name: 'edit', arguments: '{"path":"a.ts"}' }]))
    expect(a).not.toBe(
      stepToolCallsFingerprint([
        { name: 'read', arguments: '{"path":"a.ts"}' },
        { name: 'read', arguments: '{"path":"b.ts"}' }
      ])
    )
  })

  it('tracks identical-step streaks and resets on change', () => {
    expect(nextIdenticalStepStreak('', 0, 'fp1')).toBe(1)
    expect(nextIdenticalStepStreak('fp1', 1, 'fp1')).toBe(2)
    expect(nextIdenticalStepStreak('fp1', 5, 'fp2')).toBe(1)
  })

  it('does not stop on step count alone', () => {
    expect(loopStopDecision({ step: 101, identicalStepStreak: 0 })).toBeUndefined()
    expect(loopStopDecision({ step: 10_000, identicalStepStreak: 0 })).toBeUndefined()
  })

  it('never stops the run on identical-step or tool-failure streaks', () => {
    expect(
      loopStopDecision({
        step: 9,
        identicalStepStreak: MAX_IDENTICAL_STEP_STREAK
      })
    ).toBeUndefined()
    expect(
      loopStopDecision({
        step: 9,
        identicalStepStreak: MAX_IDENTICAL_STEP_STREAK * 10
      })
    ).toBeUndefined()
    expect(
      loopStopDecision({
        step: 12,
        consecutiveToolFailureSteps: 8,
        identicalStepStreak: 1
      })
    ).toBeUndefined()
    expect(
      loopStopDecision({
        step: 12,
        consecutiveToolFailureSteps: 80,
        identicalStepStreak: 1
      })
    ).toBeUndefined()
  })

  it('lets healthy long runs continue', () => {
    expect(loopStopDecision({ step: 40, identicalStepStreak: 2 })).toBeUndefined()
    expect(
      loopStopDecision({
        step: 40,
        consecutiveToolFailureSteps: 0,
        identicalStepStreak: 2
      })
    ).toBeUndefined()
  })
})
