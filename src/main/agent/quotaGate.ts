/**
 * Quota-exhaustion gate: provider usage limits are billing gates, not
 * transient throttling. Evidence: run 6265fa90 (2026-08-31) — opencode
 * glm-5.3-flash returned HTTP 429 "Weekly usage limit reached. Resets in 6
 * days" and the goal relaunch path fired 472 times in ~4 minutes until the
 * 500-step runaway-loop guard stopped the run. Quota like that cannot clear
 * within a circuit window, so a quota-exhausted stop is TERMINAL (non-resumable):
 * no automatic relaunch, the user Continue's after the plan resets.
 *
 * Detection is message-based because the wire error that reaches the loop is
 * the provider's human-readable message (PROVIDER_HTTP carries the provider
 * body; the circuit chunk that finally goes terminal carries no status).
 */

export const QUOTA_EXHAUSTED_STOP_CODE = 'QUOTA_EXHAUSTED'

const QUOTA_MESSAGE_RE =
  /weekly usage limit|usage limit reached|quota exceeded|quota exhausted|monthly usage limit|rate limit.*(?:billing|plan).*(?:exhaust|reached)/i

/**
 * Extract the reset horizon from a provider quota message as a display phrase
 * ("6 days", "2 hours", "32 minutes"). Returns null when none is stated.
 * Handles opencode's day-shaped ("Resets in 6 days"), hour-shaped
 * ("resets in 36 hours") and minutes-shaped ("Resets in 32min") variants —
 * the minutes form is real: run f086bc66 / c3290c9d (2026-09-01) hit
 * "5-hour usage limit reached. Resets in 32min." and, without a minutes
 * branch, the stop message degraded to "resets in soon".
 */
export function parseQuotaResetHorizon(message: string): string | null {
  const d = message.match(/resets? in (\d+)\s*days?/i)
  if (d) return `${d[1]} ${Number(d[1]) === 1 ? 'day' : 'days'}`
  const h = message.match(/resets? in (\d+)\s*hours?/i)
  if (h) return `${h[1]} ${Number(h[1]) === 1 ? 'hour' : 'hours'}`
  const m = message.match(/resets? in (\d+)\s*min/i)
  if (m) return `${m[1]} ${Number(m[1]) === 1 ? 'minute' : 'minutes'}`
  return null
}

/**
 * True when a provider failure message is a usage-limit / quota exhaustion
 * (billing gate), as opposed to transient rate-limit throttling.
 * Fixture is verbatim from vyotiq.log run 6265fa90, 2026-08-31T17:43:24Z.
 */
export function isQuotaExhaustedMessage(message: string): boolean {
  const s = message.trim()
  if (!s) return false
  return QUOTA_MESSAGE_RE.test(s)
}

/** Canonical terminal stop message for a quota-exhausted run. */
export function quotaExhaustedStopMessage(resetHorizon: string | null): string {
  const tail = resetHorizon ?? 'soon'
  return (
    'Provider usage limit reached (quota exhausted, resets in ' +
    tail +
    '). Nothing is retried automatically. Resume with "continue" once the plan resets, or switch the provider/model.'
  )
}
