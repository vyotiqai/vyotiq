import { describe, expect, it } from 'vitest'
import {
  QUOTA_EXHAUSTED_STOP_CODE,
  isQuotaExhaustedMessage,
  parseQuotaResetHorizon,
  quotaExhaustedStopMessage
} from '@main/agent/quotaGate'
import { parseCircuitRetryAfterMs } from '@main/agent/circuitBreaker'
import { planGoalRelaunch, MAX_AUTO_RELAUNCH_PER_RUN } from '@main/agent/goalRelaunchPlan'
import type { RunStatus } from '@shared/ipc'

// Verbatim from %APPDATA%/vyotiq/logs/vyotiq.log run 6265fa90,
// 2026-08-31T17:43:24.373Z (Provider http failure, opencode glm-5.3-flash, 429).
const INCIDENT_QUOTA_MESSAGE =
  'Weekly usage limit reached. Resets in 6 days. To continue using this model now, ' +
  'enable usage from your available balance: https://opencode.ai/workspace/wrk_EXAMPLE/go'
// Verbatim shape of the CircuitOpenError message that went terminal in the storm.
const INCIDENT_CIRCUIT_MESSAGE = 'Circuit open for http:opencode.ai; retry in 58s'

const resumableCircuitStatus: RunStatus = {
  status: 'error',
  step: 29,
  updatedAt: '2026-08-31T17:44:16.904Z',
  error: INCIDENT_CIRCUIT_MESSAGE,
  resumable: true
}

const resumableQuotaStatus: RunStatus = {
  ...resumableCircuitStatus,
  error: quotaExhaustedStopMessage('6 days')
}

describe('quotaGate', () => {
  it('matches the verbatim incident quota message', () => {
    expect(isQuotaExhaustedMessage(INCIDENT_QUOTA_MESSAGE)).toBe(true)
  })

  it('matches other usage-limit phrasings', () => {
    expect(isQuotaExhaustedMessage('monthly usage limit exceeded for this key')).toBe(true)
    expect(isQuotaExhaustedMessage('Quota exceeded for model glm-5.3-flash')).toBe(true)
    expect(isQuotaExhaustedMessage('usage limit reached — upgrade your plan')).toBe(true)
  })

  it('does not match transient rate limits, network errors, or empty text', () => {
    expect(isQuotaExhaustedMessage('Rate limit exceeded, retry after 12s')).toBe(false)
    expect(
      isQuotaExhaustedMessage('Connect timed out waiting for response headers after 30000ms')
    ).toBe(false)
    expect(isQuotaExhaustedMessage('socket hang up')).toBe(false)
    expect(isQuotaExhaustedMessage('')).toBe(false)
  })

  it('parses the reset horizon', () => {
    expect(parseQuotaResetHorizon(INCIDENT_QUOTA_MESSAGE)).toBe('6 days')
    expect(parseQuotaResetHorizon('usage limit reached. resets in 2 days')).toBe('2 days')
    expect(parseQuotaResetHorizon('resets in 36 hours')).toBe('36 hours')
    // Minutes shape is real: opencode "5-hour usage limit reached. Resets in
    // 32min." (runs f086bc66 / c3290c9d, 2026-09-01) degraded to "resets in
    // soon" without a minutes branch.
    expect(parseQuotaResetHorizon('5-hour usage limit reached. Resets in 32min.')).toBe(
      '32 minutes'
    )
    expect(parseQuotaResetHorizon('quota exceeded')).toBeNull()
  })

  it('exposes the stop code and a user-facing message with the reset horizon', () => {
    expect(QUOTA_EXHAUSTED_STOP_CODE).toBe('QUOTA_EXHAUSTED')
    expect(quotaExhaustedStopMessage('6 days')).toContain('resets in 6 days')
    expect(quotaExhaustedStopMessage('1 day')).toContain('resets in 1 day')
    expect(quotaExhaustedStopMessage(null)).toContain('resets in soon')
    // "Weekly" lied for 5-hour windows — the gate must not name a plan shape.
    expect(
      quotaExhaustedStopMessage('32 minutes').startsWith('Provider usage limit reached')
    ).toBe(true)
  })
})

describe('planGoalRelaunch (goal relaunch gate)', () => {
  const base = {
    terminalStatus: 'error' as const,
    goalActive: true,
    relaunchCount: 0
  }

  it('blocks relaunch on a quota-exhausted stop even with an active goal', () => {
    expect(planGoalRelaunch({ ...base, persisted: resumableQuotaStatus })).toEqual({
      kind: 'blocked_quota',
      reason: 'quota_exhausted'
    })
  })

  it('honors the circuit retry window as a delayed relaunch (incident: 58s)', () => {
    expect(planGoalRelaunch({ ...base, persisted: resumableCircuitStatus })).toEqual({
      kind: 'delayed',
      delayMs: 58_000
    })
  })

  it('clamps the delay to [1s, 120s]', () => {
    const soon = planGoalRelaunch({
      ...base,
      persisted: { ...resumableCircuitStatus, error: 'Circuit open for http:x; retry in 1s' }
    })
    expect(soon).toEqual({ kind: 'delayed', delayMs: 1_000 })
    const far = planGoalRelaunch({
      ...base,
      persisted: { ...resumableCircuitStatus, error: 'Circuit open for http:x; retry in 900s' }
    })
    expect(far).toEqual({ kind: 'delayed', delayMs: 120_000 })
  })

  it('returns budget_exhausted after MAX_AUTO_RELAUNCH_PER_RUN delayed relaunches', () => {
    expect(MAX_AUTO_RELAUNCH_PER_RUN).toBeGreaterThan(0)
    expect(planGoalRelaunch({ ...base, persisted: resumableCircuitStatus, relaunchCount: 5 })).toEqual(
      { kind: 'budget_exhausted', maxAutoRelaunches: MAX_AUTO_RELAUNCH_PER_RUN }
    )
    expect(
      planGoalRelaunch({
        ...base,
        persisted: resumableCircuitStatus,
        relaunchCount: 2,
        maxAutoRelaunches: 2
      })
    ).toEqual({ kind: 'budget_exhausted', maxAutoRelaunches: 2 })
  })

  it('still relaunches immediately for plain network stops', () => {
    expect(
      planGoalRelaunch({
        ...base,
        persisted: {
          ...resumableCircuitStatus,
          error: 'Connect timed out waiting for response headers after 30000ms'
        }
      })
    ).toEqual({ kind: 'immediate' })
  })

  it('does not relaunch non-resumable, non-error, inline-instance, or inactive-goal stops', () => {
    const none: { kind: 'none' } = { kind: 'none' }
    expect(
      planGoalRelaunch({ ...base, persisted: { ...resumableCircuitStatus, resumable: undefined } })
    ).toEqual(none)
    expect(
      planGoalRelaunch({ ...base, terminalStatus: 'done', persisted: resumableCircuitStatus })
    ).toEqual(none)
    expect(
      planGoalRelaunch({
        ...base,
        persisted: { ...resumableCircuitStatus, inlineInstance: true }
      })
    ).toEqual(none)
    expect(planGoalRelaunch({ ...base, goalActive: false, persisted: resumableCircuitStatus })).toEqual(
      none
    )
    expect(planGoalRelaunch({ ...base, persisted: null })).toEqual(none)
  })

  it('parses the incident circuit-message shape for the retry window', () => {
    expect(parseCircuitRetryAfterMs(INCIDENT_CIRCUIT_MESSAGE)).toBe(58_000)
    expect(parseCircuitRetryAfterMs('Circuit open for provider:opencode:http:x; retry in 60s')).toBe(
      60_000
    )
    expect(parseCircuitRetryAfterMs('Provider stream failed after 2 attempts')).toBeNull()
  })
})
