import { describe, expect, it } from 'vitest'
import {
  loopStopDecision,
  MAX_IDENTICAL_STEP_STREAK,
  MAX_IDENTICAL_STEP_STREAK_TERMINAL,
  MAX_CONSECUTIVE_TOOL_FAILURE_STEPS,
  FAILURE_SIGNATURE_WINDOW,
  nextIdenticalStepStreak,
  nextToolFailureStreak,
  stepFailureSignature,
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

  it('charges the failure streak only when a failed attempt repeats (run 3d8e0ead)', () => {
    // 2026-09-02: gh pr checks → gh run view --log-failed → --job --log →
    // gh api .../logs were four DISTINCT attempts against one external
    // blocker; the old all-failed counter reached 4 and killed the run.
    let streak = 0
    let recent: string[] = []
    for (const sig of ['sig-a', 'sig-b', 'sig-c', 'sig-d']) {
      const next = nextToolFailureStreak(streak, sig, recent)
      streak = next.streak
      recent = next.recentSignatures
    }
    expect(streak).toBeLessThan(MAX_CONSECUTIVE_TOOL_FAILURE_STEPS)
    expect(recent).toEqual(['sig-d', 'sig-c', 'sig-b', 'sig-a'])

    // Repeating the newest failed attempt charges toward the stop; a brand-new
    // attempt shape holds the streak instead of charging it.
    expect(nextToolFailureStreak(streak, 'sig-d', recent).streak).toBe(2)
    expect(nextToolFailureStreak(3, 'sig-new', ['sig-old']).streak).toBe(3)
  })

  it('reaches the stop threshold only through repeats, and caps there', () => {
    let streak = 0
    let recent: string[] = ['sig']
    for (let i = 0; i < 10; i++) {
      const next = nextToolFailureStreak(streak, 'sig', recent)
      streak = next.streak
      recent = next.recentSignatures
      expect(streak).toBeLessThanOrEqual(MAX_CONSECUTIVE_TOOL_FAILURE_STEPS)
    }
    expect(streak).toBe(MAX_CONSECUTIVE_TOOL_FAILURE_STEPS)
    expect(loopStopDecision({ step: 9, consecutiveToolFailureSteps: streak })).toBeDefined()
  })

  it('bounds the recent-signature window', () => {
    let recent: string[] = []
    for (let i = 0; i < FAILURE_SIGNATURE_WINDOW + 5; i++) {
      recent = nextToolFailureStreak(1, `sig-${i}`, recent).recentSignatures
    }
    expect(recent.length).toBe(FAILURE_SIGNATURE_WINDOW)
  })

  it('signatures hash failed tool name + result head (terminal echoes the command)', () => {
    const base = [
      {
        role: 'tool' as const,
        toolName: 'terminal',
        ok: false,
        content: 'status: done\ncommand: gh pr checks 17\nexit_code: 1'
      }
    ]
    expect(stepFailureSignature(base)).toBe(stepFailureSignature(base))
    expect(stepFailureSignature(base)).not.toBe(
      stepFailureSignature([
        {
          role: 'tool',
          toolName: 'terminal',
          ok: false,
          content: 'status: done\ncommand: gh run view --log-failed\nexit_code: 1'
        }
      ])
    )
    // Successful results do not participate in the signature.
    expect(
      stepFailureSignature([{ role: 'tool', toolName: 'terminal', ok: true, content: 'ok' }])
    ).toBe(stepFailureSignature([]))
  })
})
