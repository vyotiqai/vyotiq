import type { AgentEvent } from '../ipc'

export type StepUsageTotals = {
  /** Latest step's full context / input window size (not cumulative bill). */
  inputTokens: number
  /** Sum of per-step inputTokens — true multi-step billed input shape. */
  billedInputTokens: number
  /** Peak per-step inputTokens this run. */
  peakInputTokens: number
  /** Sum of output tokens across steps. */
  outputTokens: number
  /** Latest step's cached input (window-relative). */
  cachedInputTokens: number
  /** Sum of per-step cached input tokens (for run-level hit rate). */
  billedCachedInputTokens: number
  /** Tokens written into the prompt cache this run (Anthropic); accumulates across steps. */
  cacheCreationInputTokens: number
  /** Billed thinking tokens, a subset of the output tokens above. */
  reasoningTokens: number
  steps: number
  /** Steps where the provider reported any cache field (hit or write). */
  stepsWithCacheReport: number
}

export function emptyStepUsageTotals(): StepUsageTotals {
  return {
    inputTokens: 0,
    billedInputTokens: 0,
    peakInputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    billedCachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    steps: 0,
    stepsWithCacheReport: 0
  }
}

export function mergeStepUsageTotals(a: StepUsageTotals, b: StepUsageTotals): StepUsageTotals {
  const nextInput = b.inputTokens > 0 ? b.inputTokens : a.inputTokens
  const stepInput = b.inputTokens > 0 ? b.inputTokens : 0
  const stepCached = b.inputTokens > 0 ? b.cachedInputTokens : 0
  return {
    inputTokens: nextInput,
    billedInputTokens: a.billedInputTokens + stepInput,
    peakInputTokens: Math.max(a.peakInputTokens, stepInput, a.inputTokens),
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: b.inputTokens > 0 ? b.cachedInputTokens : a.cachedInputTokens,
    billedCachedInputTokens: a.billedCachedInputTokens + stepCached,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    steps: a.steps + b.steps,
    stepsWithCacheReport: a.stepsWithCacheReport + b.stepsWithCacheReport
  }
}

export function stepUsageFromEvent(event: AgentEvent): StepUsageTotals | null {
  if (event.type !== 'step_usage') return null
  const inputTokens = event.inputTokens ?? 0
  const cachedInputTokens = event.cachedInputTokens ?? 0
  const cacheCreationInputTokens = event.cacheCreationInputTokens ?? 0
  const cacheReported = cachedInputTokens > 0 || cacheCreationInputTokens > 0
  return {
    inputTokens,
    billedInputTokens: inputTokens,
    peakInputTokens: inputTokens,
    outputTokens: event.outputTokens ?? 0,
    cachedInputTokens,
    billedCachedInputTokens: cachedInputTokens,
    cacheCreationInputTokens,
    reasoningTokens: event.reasoningTokens ?? 0,
    steps: 1,
    stepsWithCacheReport: cacheReported ? 1 : 0
  }
}

/**
 * Rebuild cumulative step usage from durable events.
 * Always sums per-step `inputTokens` / cache / output — ignores event-carried
 * `billedInputTokens` (those are process-local and reset on resume).
 */
export function stepUsageTotalsFromPersistedEvents(
  events: ReadonlyArray<{ event?: unknown }>
): StepUsageTotals {
  let totals = emptyStepUsageTotals()
  for (const row of events) {
    const ev = row.event as AgentEvent | undefined
    if (!ev || ev.type !== 'step_usage') continue
    const partial = stepUsageFromEvent(ev)
    if (partial) totals = mergeStepUsageTotals(totals, partial)
  }
  return totals
}
