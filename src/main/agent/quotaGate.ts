/**
 * Quota-exhaustion gate: weekly provider usage limits are billing gates, not
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
 * Extract the reset horizon from a provider quota message, in whole days.
 * Returns null when the message does not state one.
 * Works on opencode's "Resets in 6 days" and hour-shaped variants.
 */
export function parseQuotaResetDays(message: string): number | null {
  const m = message.match(/resets? in (\d+)\s*days?/i)
  if (m) return Math.max(0, Number(m[1]))
  const h = message.match(/resets? in (\d+)\s*hours?/i)
  if (h) return Math.max(0, Math.ceil(Number(h[1]) / 24))
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
export function quotaExhaustedStopMessage(resetDays: number | null): string {
  const tail = resetDays == null ? 'soon' : resetDays === 1 ? '1 day' : `${resetDays} days`
  return (
    'Provider weekly usage limit reached (quota exhausted, resets in ' +
    tail +
    '). Nothing is retried automatically. Resume with "continue" once the plan resets, or switch the provider/model.'
  )
}
