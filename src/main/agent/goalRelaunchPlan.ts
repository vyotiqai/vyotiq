import type { RunStatus } from '../../shared/ipc'
import { parseCircuitRetryAfterMs } from './circuitBreaker'
import { isQuotaExhaustedMessage } from './quotaGate'

/**
 * Cap on automatic relaunches of one active-goal run after resumable stops.
 * Run 6265fa90 (2026-08-31): a circuit-open storm produced 472 relaunches in
 * ~4 minutes until the 500-step runaway-loop guard stopped the run. Honoring
 * the circuit's retryAfterMs fixes the storm mechanism; this budget is the
 * second line of defense. Exceeding it leaves the goal ACTIVE — a user
 * Continue or app restart resumes it; nothing is dropped.
 */
export const MAX_AUTO_RELAUNCH_PER_RUN = 5

/**
 * Pure relaunch decision for a stopped goal run, extracted so the gate logic
 * is unit-testable. The caller owns disk/registry state (readGoal, isActive)
 * and executes the plan.
 */
export type GoalRelaunchPlan =
  | { kind: 'none' }
  | { kind: 'blocked_quota'; reason: string }
  | { kind: 'budget_exhausted'; maxAutoRelaunches: number }
  | { kind: 'immediate' }
  | { kind: 'delayed'; delayMs: number }

export function planGoalRelaunch(opts: {
  terminalStatus: 'done' | 'error' | 'cancelled' | undefined
  persisted: RunStatus | null
  goalActive: boolean
  relaunchCount: number
  maxAutoRelaunches?: number
}): GoalRelaunchPlan {
  const max = opts.maxAutoRelaunches ?? MAX_AUTO_RELAUNCH_PER_RUN
  const persisted = opts.persisted
  if (opts.terminalStatus !== 'error') return { kind: 'none' }
  if (persisted?.status !== 'error' || persisted.resumable !== true) return { kind: 'none' }
  if (persisted.inlineInstance === true) return { kind: 'none' }
  const persistedError = persisted.error ?? ''
  // Quota exhaustion is a billing gate, not an outage — relaunching cannot
  // succeed until the plan resets. The goal stays active but waits for a user
  // continue / app restart.
  if (
    isQuotaExhaustedMessage(persistedError) ||
    (persisted as { stopReason?: string }).stopReason === 'quota_exhausted'
  ) {
    return { kind: 'blocked_quota', reason: 'quota_exhausted' }
  }
  if (!opts.goalActive) return { kind: 'none' }
  const retryAfterMs = parseCircuitRetryAfterMs(persistedError)
  if (retryAfterMs != null && retryAfterMs > 0) {
    if (opts.relaunchCount >= max) {
      return { kind: 'budget_exhausted', maxAutoRelaunches: max }
    }
    // Circuit-open stop: honor the provider host's retry window. The
    // 2026-08-31 storm fired here every ~0.25s because the persisted backoff
    // was ignored. ONE delayed relaunch per stop; budget-capped.
    return { kind: 'delayed', delayMs: Math.max(1_000, Math.min(retryAfterMs, 120_000)) }
  }
  return { kind: 'immediate' }
}
