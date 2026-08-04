import { describe, expect, it } from 'vitest'
import {
  loopStopDecision,
  MAX_CONSECUTIVE_TOOL_FAILURE_STEPS,
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
    expect(
      loopStopDecision({
        step: 101,
        consecutiveToolFailureSteps: 0,
        identicalStepStreak: 0
      })
    ).toBeUndefined()
    expect(
      loopStopDecision({
        step: 10_000,
        consecutiveToolFailureSteps: 0,
        identicalStepStreak: 0
      })
    ).toBeUndefined()
  })

  it('stops after too many consecutive failed tool steps', () => {
    const stop = loopStopDecision({
      step: 3,
      consecutiveToolFailureSteps: MAX_CONSECUTIVE_TOOL_FAILURE_STEPS,
      identicalStepStreak: 0
    })
    expect(stop?.reason).toBe('tool_failure_streak')
    expect(
      loopStopDecision({
        step: 3,
        consecutiveToolFailureSteps: MAX_CONSECUTIVE_TOOL_FAILURE_STEPS - 1,
        identicalStepStreak: 0
      })
    ).toBeUndefined()
  })

  it('stops when the same step repeats too many times', () => {
    const stop = loopStopDecision({
      step: 9,
      consecutiveToolFailureSteps: 0,
      identicalStepStreak: MAX_IDENTICAL_STEP_STREAK
    })
    expect(stop?.reason).toBe('identical_step_streak')
    expect(stop?.message).toMatch(/consecutive tool steps/i)
    expect(
      loopStopDecision({
        step: 9,
        consecutiveToolFailureSteps: 0,
        identicalStepStreak: MAX_IDENTICAL_STEP_STREAK - 1
      })
    ).toBeUndefined()
  })

  it('lets healthy long runs continue', () => {
    expect(
      loopStopDecision({ step: 40, consecutiveToolFailureSteps: 2, identicalStepStreak: 3 })
    ).toBeUndefined()
  })
})
