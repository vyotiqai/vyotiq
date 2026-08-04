/**
 * Compaction payback gate (provider-agnostic).
 *
 * Anthropic Claude Code costs docs: `/compact` itself is a large request that only
 * pays back when later steps rebill a smaller window. Prefer cheap trim first;
 * invoke the compaction LLM only when foldable history is large enough and the
 * residual floor can fall under the soft trigger.
 */

/** Absolute minimum foldable tokens before paying for an LLM summarize call. */
export const COMPACTION_LLM_MIN_FOLD_TOKENS = 4_000

/**
 * Foldable history must also be at least this fraction of the soft trigger,
 * so tiny overshoots pay with trim instead of a full summarize request.
 */
export const COMPACTION_LLM_MIN_FOLD_FRACTION = 0.08

/** Assumed upper bound for a compaction summary once injected into system. */
export const COMPACTION_SUMMARY_RESERVE_TOKENS = 1_200

export type CompactionPaybackDecision = {
  invokeLlm: boolean
  reason: 'payback' | 'fold_too_small' | 'residual_above_trigger' | 'prefer_trim'
}

/**
 * Decide whether an LLM compaction call is expected to pay for itself.
 *
 * @param foldTokens — tokens in the prefix that would be summarized away
 * @param residualFloor — estimated tokens that remain even after a perfect fold
 *   (kept recent turns + system + tools + summary reserve)
 * @param trigger — soft compaction trigger
 * @param hasPriorLlmSummary — true when a real (non-watermark) summary already exists
 */
export function shouldInvokeCompactionLlm(input: {
  foldTokens: number
  residualFloor: number
  trigger: number
  hasPriorLlmSummary?: boolean
}): CompactionPaybackDecision {
  const { foldTokens, residualFloor, trigger } = input
  const minFold = Math.max(
    COMPACTION_LLM_MIN_FOLD_TOKENS,
    Math.floor(trigger * COMPACTION_LLM_MIN_FOLD_FRACTION)
  )

  if (foldTokens < minFold) {
    return { invokeLlm: false, reason: 'fold_too_small' }
  }

  // Even a perfect fold cannot land under the soft trigger — skip the LLM tax.
  if (trigger > 0 && residualFloor >= trigger) {
    return { invokeLlm: false, reason: 'residual_above_trigger' }
  }

  // Marginal overshoot with an existing summary: prefer trim over re-summarizing.
  if (
    input.hasPriorLlmSummary &&
    trigger > 0 &&
    foldTokens < trigger * 0.15 &&
    residualFloor > trigger * 0.85
  ) {
    return { invokeLlm: false, reason: 'prefer_trim' }
  }

  return { invokeLlm: true, reason: 'payback' }
}

/** Build residual floor from layer-ish estimates (kept + system + tools + summary). */
export function residualFloorAfterFold(input: {
  keptTokens: number
  systemTokens: number
  toolsTokens: number
  summaryReserve?: number
}): number {
  return (
    Math.max(0, input.keptTokens) +
    Math.max(0, input.systemTokens) +
    Math.max(0, input.toolsTokens) +
    Math.max(0, input.summaryReserve ?? COMPACTION_SUMMARY_RESERVE_TOKENS)
  )
}
