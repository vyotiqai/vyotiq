import { describe, expect, it } from 'vitest'
import {
  loopStopDecision,
  MAX_IDENTICAL_STEP_STREAK,
  MAX_IDENTICAL_STEP_STREAK_TERMINAL,
  MAX_CONSECUTIVE_TOOL_FAILURE_STEPS,
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

  it('stops the run on identical-step or tool-failure streaks', () => {
    // Identical repeats below the terminal ceiling steer via the escalating hint
    // (loopHintForIdenticalStepStreak) instead of stopping the run.
    expect(
      loopStopDecision({ step: 9, identicalStepStreak: MAX_IDENTICAL_STEP_STREAK })
    ).toBeUndefined()

    const identical = loopStopDecision({
      step: 9,
      identicalStepStreak: MAX_IDENTICAL_STEP_STREAK_TERMINAL
    })
    expect(identical).toBeDefined()
    expect(identical?.reason).toBe('identical_step_streak')

    const identicalLong = loopStopDecision({
      step: 9,
      identicalStepStreak: MAX_IDENTICAL_STEP_STREAK_TERMINAL * 10
    })
    expect(identicalLong).toBeDefined()
    expect(identicalLong?.reason).toBe('identical_step_streak')

    const failStop = loopStopDecision({
      step: 12,
      consecutiveToolFailureSteps: 8,
      identicalStepStreak: 1
    })
    expect(failStop).toBeDefined()
    expect(failStop?.reason).toBe('tool_failure_streak')

    const failStopLong = loopStopDecision({
      step: 12,
      consecutiveToolFailureSteps: 80,
      identicalStepStreak: 1
    })
    expect(failStopLong).toBeDefined()
    expect(failStopLong?.reason).toBe('tool_failure_streak')
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
    // One step below each threshold must not stop.
    expect(
      loopStopDecision({ step: 40, identicalStepStreak: MAX_IDENTICAL_STEP_STREAK - 1 })
    ).toBeUndefined()
    expect(
      loopStopDecision({
        step: 40,
        consecutiveToolFailureSteps: MAX_CONSECUTIVE_TOOL_FAILURE_STEPS - 1,
        identicalStepStreak: 1
      })
    ).toBeUndefined()
  })
})
