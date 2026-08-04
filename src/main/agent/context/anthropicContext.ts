import type { ModelInfo, ProviderId } from '../../../shared/ipc'
import { COMPACTION_SOFT_CAP_TOKENS } from '../../../shared/domain/contextBudget'
import { COMPACTION_TRIGGER_RATIO, KEEP_LAST_TOOL_RESULTS } from './types'
import { compactionTriggerTokens, contentWindow } from './budget'
import { DURABLE_TOOL_RESULT_NAMES } from './durableToolResults'

const ANTHROPIC_COMPACT_MIN_TRIGGER = 8_000
/** Floor for clear_tool_uses trigger on large windows — avoid clearing every short turn. */
const ANTHROPIC_CLEAR_TOOL_USES_MIN_TRIGGER = 32_000
/**
 * Minimum tokens cleared per clear_tool_uses activation so a cache rewrite is worth it
 * (Anthropic context-editing docs: use clear_at_least).
 */
const ANTHROPIC_CLEAR_TOOL_USES_AT_LEAST = 5_000
/** clear_tool_uses fires earlier than server compact; ~35% of content window. */
const ANTHROPIC_CLEAR_TOOL_USES_RATIO = 0.35

/** Server exclude_tools — same durable set as client trim (single source of truth). */
export const ANTHROPIC_CLEAR_TOOL_USES_EXCLUDE = DURABLE_TOOL_RESULT_NAMES

export function anthropicNativeOptions(
  providerId: ProviderId,
  model: ModelInfo | number,
  triggerRatio = COMPACTION_TRIGGER_RATIO
): {
  enableContextManagement: boolean
  clearToolUsesKeep: number
  compactTriggerTokens: number
  clearToolUsesTriggerTokens: number
  clearToolUsesAtLeastTokens: number
  clearToolUsesExcludeTools: string[]
} {
  const enable = providerId === 'anthropic'
  const contentWin = typeof model === 'number' ? model : contentWindow(model)
  // Match client soft-cap compaction (64k on huge windows), not raw ratio×content.
  const compactTrigger =
    typeof model === 'number'
      ? Math.min(
          COMPACTION_SOFT_CAP_TOKENS,
          Math.max(ANTHROPIC_COMPACT_MIN_TRIGGER, Math.floor(contentWin * triggerRatio))
        )
      : compactionTriggerTokens(model, triggerRatio)

  const clearRatioTrigger = Math.floor(contentWin * ANTHROPIC_CLEAR_TOOL_USES_RATIO)
  // Scale the 32k floor down on mid-size windows so clear remains reachable
  // (old floor of 32k exceeded a 32k model's entire content window).
  const clearFloor = Math.min(ANTHROPIC_CLEAR_TOOL_USES_MIN_TRIGGER, clearRatioTrigger)
  const clearTrigger = Math.min(
    COMPACTION_SOFT_CAP_TOKENS,
    Math.max(clearFloor, clearRatioTrigger)
  )

  return {
    enableContextManagement: enable,
    clearToolUsesKeep: KEEP_LAST_TOOL_RESULTS,
    compactTriggerTokens: compactTrigger,
    clearToolUsesTriggerTokens: clearTrigger,
    clearToolUsesAtLeastTokens: ANTHROPIC_CLEAR_TOOL_USES_AT_LEAST,
    clearToolUsesExcludeTools: [...ANTHROPIC_CLEAR_TOOL_USES_EXCLUDE]
  }
}
