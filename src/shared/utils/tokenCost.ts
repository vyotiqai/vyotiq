/**
 * Token/cost attribution helpers (provider-agnostic).
 * No request bodies or secrets — counts and layer labels only.
 */

export type TokenCostLayers = {
  system: number
  history: number
  tools: number
  buffer: number
}

export type TokenCostHotspot = 'history' | 'tools' | 'system' | 'balanced'

/** Which estimate layer dominates content (excludes buffer share). */
export function classifyTokenCostHotspot(layers: TokenCostLayers): TokenCostHotspot {
  const ranked: Array<{ key: TokenCostHotspot; n: number }> = [
    { key: 'history', n: layers.history },
    { key: 'tools', n: layers.tools },
    { key: 'system', n: layers.system }
  ]
  ranked.sort((a, b) => b.n - a.n)
  const top = ranked[0]
  const second = ranked[1]
  if (!top || top.n <= 0) return 'balanced'
  if (second && top.n < second.n * 1.25) return 'balanced'
  return top.key
}

/** Latest-step cache hit share, or null when the provider reported no cache fields. */
export function stepCacheHitRate(
  inputTokens: number | undefined,
  cachedInputTokens: number | undefined,
  cacheReported: boolean
): number | null {
  if (!cacheReported) return null
  if (inputTokens == null || inputTokens <= 0) return null
  const cached = Math.max(0, cachedInputTokens ?? 0)
  return Math.min(1, cached / inputTokens)
}

/** Run-level cache hit share from cumulative billed totals. */
export function billedCacheHitRate(billedInput: number, billedCached: number): number | null {
  if (billedInput <= 0 || billedCached <= 0) return null
  return Math.min(1, billedCached / billedInput)
}

export type TokenCostWarnKind =
  | 'context_above_soft_trigger'
  | 'low_cache_hit_rate'
  | 'high_context_watermark'
  | 'high_thinking_on_long_run'
  | 'long_run_task_boundary'

/**
 * Advisory cost hints belong in ContextMeter / Think chips — not composer `runNotice`.
 * Operational notices (compaction, deferred MCP, Stopping…) use other event types.
 */
export function isAdvisoryTokenCostHint(kind: TokenCostWarnKind): boolean {
  switch (kind) {
    case 'long_run_task_boundary':
    case 'high_thinking_on_long_run':
    case 'high_context_watermark':
    case 'context_above_soft_trigger':
    case 'low_cache_hit_rate':
      return true
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

/** Steps at/above which we suggest /clear between unrelated tasks (P-CLEAR). */
export const LONG_RUN_STEP_HINT_THRESHOLD = 40

/** Cumulative billed input at/above which we suggest a task boundary (P-CLEAR). */
export const LONG_RUN_BILLED_INPUT_HINT_THRESHOLD = 1_000_000

/**
 * Steps at/above which high thinking effort warrants a user-facing “suggest lower” cue (P-THINK).
 * Matches `high_thinking_on_long_run` in `evaluateTokenCostWarnings`.
 */
export const HIGH_THINKING_LONG_RUN_STEP_THRESHOLD = 10

/** Effort ranks for stepping down (never silent — UI must call this only on user action). */
const THINKING_EFFORT_RANK = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const

export type ThinkingEffortForCost = (typeof THINKING_EFFORT_RANK)[number]

export function isHighThinkingEffort(effort: string | null | undefined): boolean {
  return effort === 'high' || effort === 'xhigh' || effort === 'max'
}

/**
 * True when the composer should offer an explicit “Lower” action (never auto-apply).
 * Aligns with the long-run high-thinking warning threshold.
 */
export function shouldSuggestLowerThinkingEffort(input: {
  thinkingEnabled: boolean
  thinkingEffort: string | null | undefined
  steps: number
  /** Boolean On/Off thinking has no effort ladder — hide the chip. */
  thinkingMode?: 'boolean' | 'effort' | string | null
}): boolean {
  if (!input.thinkingEnabled) return false
  if (input.thinkingMode === 'boolean') return false
  if (!isHighThinkingEffort(input.thinkingEffort)) return false
  return input.steps >= HIGH_THINKING_LONG_RUN_STEP_THRESHOLD
}

/**
 * Next lower effort within `allowed` (or the full ladder). Returns null when already
 * at the bottom of the allowed set — caller must not invent a silent Off.
 */
export function nextLowerThinkingEffort(
  current: string,
  allowed?: readonly string[] | null
): ThinkingEffortForCost | null {
  const pool =
    allowed && allowed.length > 0
      ? THINKING_EFFORT_RANK.filter((e) => allowed.includes(e))
      : [...THINKING_EFFORT_RANK]
  if (pool.length === 0) return null
  const idx = pool.indexOf(current as ThinkingEffortForCost)
  if (idx <= 0) {
    // Current not in pool, or already lowest — try rank below current in full ladder
    // then pick the highest allowed that is still strictly below.
    const fullIdx = THINKING_EFFORT_RANK.indexOf(current as ThinkingEffortForCost)
    if (fullIdx <= 0) return null
    for (let i = fullIdx - 1; i >= 0; i--) {
      const candidate = THINKING_EFFORT_RANK[i]!
      if (pool.includes(candidate)) return candidate
    }
    return null
  }
  return pool[idx - 1] ?? null
}

export type TokenCostWarning = {
  kind: TokenCostWarnKind
  message: string
}

/**
 * Structured cost warnings (not spammy — callers gate by step counts / once flags).
 * Messages are log-oriented; use `userFacingTokenCostHint` for composer notices.
 */
export function evaluateTokenCostWarnings(input: {
  estimatedTokens: number
  compactionTrigger: number
  contentWindow: number
  compactedThisRun: boolean
  cacheHitRate: number | null
  stepsWithCacheReport: number
  largeInput: boolean
  thinkingEnabled: boolean
  thinkingEffortHigh: boolean
  step: number
  /** Cumulative Σ step inputs this run (true bill shape). */
  billedInputTokens?: number
}): TokenCostWarning[] {
  const out: TokenCostWarning[] = []
  if (
    input.compactedThisRun &&
    input.compactionTrigger > 0 &&
    input.estimatedTokens > input.compactionTrigger * 1.25
  ) {
    out.push({
      kind: 'context_above_soft_trigger',
      message: `Context estimate ${input.estimatedTokens} still exceeds soft trigger ${input.compactionTrigger} after compaction`
    })
  }
  if (
    input.cacheHitRate != null &&
    input.stepsWithCacheReport >= 5 &&
    input.largeInput &&
    input.cacheHitRate < 0.1
  ) {
    out.push({
      kind: 'low_cache_hit_rate',
      message: `Prompt cache hit rate ${(input.cacheHitRate * 100).toFixed(1)}% over recent large steps`
    })
  }
  if (input.contentWindow > 0 && input.estimatedTokens >= input.contentWindow * 0.8) {
    out.push({
      kind: 'high_context_watermark',
      message: `Context estimate ${input.estimatedTokens} is ≥80% of content window ${input.contentWindow}`
    })
  }
  if (
    input.thinkingEnabled &&
    input.thinkingEffortHigh &&
    input.step >= HIGH_THINKING_LONG_RUN_STEP_THRESHOLD
  ) {
    out.push({
      kind: 'high_thinking_on_long_run',
      message: `Thinking is enabled at high effort on step ${input.step} — reasoning tokens accumulate every step`
    })
  }
  const billed = Math.max(0, input.billedInputTokens ?? 0)
  if (
    input.step >= LONG_RUN_STEP_HINT_THRESHOLD ||
    billed >= LONG_RUN_BILLED_INPUT_HINT_THRESHOLD
  ) {
    out.push({
      kind: 'long_run_task_boundary',
      message: `Long run at step ${input.step} (billed input ${billed}) — consider /clear between unrelated tasks`
    })
  }
  return out
}

/** Composer-facing hint copy for selected warning kinds (Claude Code costs practice). */
export function userFacingTokenCostHint(
  kind: TokenCostWarnKind,
  step?: number
): string | null {
  switch (kind) {
    case 'high_thinking_on_long_run':
      return `High thinking effort is still on at step ${step ?? '?'} — reasoning tokens accumulate every step. Lower effort in the composer for simpler work, or /clear between tasks.`
    case 'context_above_soft_trigger':
      return 'Context is still large after compaction. Prefer /clear for a new task, or /compact with a focus while continuing this one.'
    case 'high_context_watermark':
      return 'Context is near the model window. Prefer /clear between unrelated tasks, or /compact to keep continuity.'
    case 'long_run_task_boundary':
      return `This chat has been running a long time (step ${step ?? '?'}). Use /clear (new chat) when starting an unrelated task — it zeros history tokens; /compact keeps continuity for the same task.`
    case 'low_cache_hit_rate':
      return 'Prompt cache hit rate is low on large steps — avoid mid-run tool-catalog churn; /clear between unrelated tasks to restore a stable cacheable prefix.'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

/** True when step/billed totals warrant a static ContextMeter task-boundary tip. */
export function shouldShowTaskBoundaryTip(input: {
  steps: number
  billedInputTokens: number
}): boolean {
  return (
    input.steps >= LONG_RUN_STEP_HINT_THRESHOLD ||
    input.billedInputTokens >= LONG_RUN_BILLED_INPUT_HINT_THRESHOLD
  )
}

/** Count characters in non-stubbed tool message bodies (cheap hotspot signal). */
export function countKeptToolResultChars(
  messages: readonly { role?: string; content?: unknown }[],
  stubMarker = '[cleared]'
): number {
  let n = 0
  for (const m of messages) {
    if (m.role !== 'tool') continue
    const text = typeof m.content === 'string' ? m.content : ''
    if (!text || text === stubMarker || text.endsWith(stubMarker)) continue
    n += text.length
  }
  return n
}

export type ToolCallCountRow = { name: string; calls: number }

/** Rank tools by total calls (ok + failed) for run-summary cost attribution. */
export function topToolsByCallCount(
  byName: Readonly<Record<string, { ok?: number; failed?: number }>> | undefined,
  limit = 8
): ToolCallCountRow[] {
  if (!byName || limit <= 0) return []
  return Object.entries(byName)
    .map(([name, stat]) => ({
      name,
      calls: Math.max(0, (stat.ok ?? 0) + (stat.failed ?? 0))
    }))
    .filter((row) => row.calls > 0)
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, limit)
}
