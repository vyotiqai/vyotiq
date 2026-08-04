import type { ChatMessage, ModelInfo } from '../../../shared/ipc'
import type { TokenUsage } from '../providers/types'
import {
  BUDGET_SHARES as SHARED_BUDGET_SHARES,
  DEFAULT_CONTEXT_WINDOW as SHARED_DEFAULT_CONTEXT_WINDOW
} from '../../../shared/domain/contextBudget'

export type BudgetLayers = {
  system: number
  tools: number
  memoryWorkspace: number
  history: number
  buffer: number
}

/** Fixed budget shares of model context window — kept in sync via shared/domain/contextBudget. */
export const BUDGET_SHARES: BudgetLayers = SHARED_BUDGET_SHARES

export const COMPACTION_TRIGGER_RATIO = 0.7
export const KEEP_RECENT_TURNS = 12
/**
 * Ephemeral tool bodies kept mid-run (Anthropic clear_tool_uses default keep=3).
 * Durable tools (ask_question / todo / memory) are never stubbed — see
 * durableToolResults.ts. File reads are clearable (re-fetchable). keep=1 under
 * pressure caused AppData ba335d72 re-read thrash.
 */
export const KEEP_LAST_TOOL_RESULTS = 3
export const MEMORY_INDEX_CAP = 3000
export const MEMORY_STATE_CAP = 3000
export const DEFAULT_CONTEXT_WINDOW = SHARED_DEFAULT_CONTEXT_WINDOW

import { z } from 'zod'

export const CompactionRecordSchema = z.object({
  summary: z.string().min(1),
  createdAt: z.string(),
  tokenEstimate: z.number().int().min(0),
  /**
   * Count of leading messages in `messages.jsonl` that this summary already
   * represents. The loop skips them when rebuilding its working set, so a long
   * run stops re-summarizing the same prefix on every step. Older records
   * predate the field, so it stays optional.
   */
  foldedMessages: z.number().int().min(0).optional(),
  /**
   * True when context shrunk via in-message stubs (tool trim / thinking drop)
   * without dropping message count. Lets resume re-apply wire trims and lets
   * the loop adopt the stubbed working set.
   */
  wireTrimApplied: z.boolean().optional()
})
export type CompactionRecord = z.infer<typeof CompactionRecordSchema>

/**
 * Sentinel summary for trim-only watermarks. Persists `foldedMessages` across
 * resume when history was dropped without an LLM summary. Never inject into
 * the system prompt or promote to memory.
 */
export const CONTEXT_TRIM_WATERMARK_SUMMARY = '__vyotiq_context_trim_watermark__'

export function isTrimWatermarkCompaction(
  record: Pick<CompactionRecord, 'summary'> | null | undefined
): boolean {
  return record?.summary === CONTEXT_TRIM_WATERMARK_SUMMARY
}

export type AssembleInput = {
  harness: string
  messages: ChatMessage[]
  workspacePath: string | null
  goal: string
  model: ModelInfo
  toolsJsonEstimate: number
  lastUsage?: TokenUsage
  keepRecentTurns?: number
  compactionTriggerRatio?: number
  contract?: string
  priorCompaction?: CompactionRecord | null
  /** Injected when the agent loop detects repeated tool-failure steps (generic, not workspace-specific). */
  loopHint?: string
  /** Skills Level-1 metadata (name + description); full body via Skill tool or slash. */
  skillsSection?: string
  /** Plugin rules Level-1 metadata; full body via Skill tool with the rule id. */
  pluginRulesSection?: string
  /** Ask / Plan / Agent mode overlay. */
  modeSection?: string
  /** Approved or draft plan.md body (omit stub / empty). */
  plan?: string
  /** Fresh session env block (UTC + local time/tz, OS version, shell, mode) — not workspace-cached. */
  sessionEnv?: string
}

export type ContextLayerBreakdown = {
  system: number
  history: number
  tools: number
  buffer: number
}

export type AssembleResult = {
  /** Combined stable + volatile system string (all providers). */
  system: string
  /** Stable instruction prefix — Anthropic marks this with cache_control. */
  systemStable: string
  /** Volatile per-step tail (hints, snapshot, memory) — not cache-marked. */
  systemVolatile: string
  messages: ChatMessage[]
  compaction?: CompactionRecord | null
  estimatedTokens: number
  layers: ContextLayerBreakdown
  contextShrunk: boolean
  /** True when estimated tokens still exceed the content window after compaction/trim. */
  overflow: boolean
  anthropicNative: {
    enableContextManagement: boolean
    clearToolUsesKeep: number
    compactTriggerTokens: number
    clearToolUsesTriggerTokens: number
    clearToolUsesAtLeastTokens: number
    clearToolUsesExcludeTools: string[]
  }
}
