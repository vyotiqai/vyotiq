/**
 * Shared context-budget shares. Main `budget.ts` and UI rescale helpers must
 * stay in lockstep so meters match assembly.
 */
export type BudgetLayerShares = {
  system: number
  tools: number
  memoryWorkspace: number
  history: number
  buffer: number
}

export const BUDGET_SHARES: BudgetLayerShares = {
  system: 0.12,
  tools: 0.18,
  memoryWorkspace: 0.15,
  history: 0.4,
  buffer: 0.15
}

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.7

/**
 * Soft ceiling so huge context windows (e.g. 1M) still compact long tool-heavy
 * runs before the ratio-based trigger (hundreds of thousands of tokens).
 */
export const COMPACTION_SOFT_CAP_TOKENS = 64_000

/**
 * Soft ceiling for tool-*definition* tokens sent every step. Without this, the
 * 18% tools share on a 1M window (~180k) never sheds MCP schemas — AppData
 * showed a steady ~13.5k tools tax. Cap aligns with Claude Code deferral
 * practice: keep a lean catalog; pin via request_mcp_tools.
 */
export const TOOLS_SOFT_CAP_TOKENS = 8_000

/**
 * After this many agent steps without a pin refresh or MCP invoke, a pinned MCP
 * tool may be evicted from the sticky step catalog (re-pin anytime).
 *
 * Tuned from AppData `80bd4074` (155 steps; 101× read + 96× terminal vs sparse MCP
 * invokes): TTL 8 caused premature unload during read/terminal bursts → re-pin →
 * catalog fingerprint churn. 16 covers typical tool bursts without immortal pins.
 */
export const MCP_PIN_IDLE_TTL_STEPS = 16

/**
 * Soft ceiling on how many pinned MCP tool schemas stay in the step catalog.
 * Excess are LRU-evicted (required builtins are never touched).
 *
 * AppData omit previews showed ~27–30 connected MCP names; successful unique MCP
 * tools in the case study were ≪ 12. Cap stays 12 so schema tax stays under tools soft cap.
 */
export const MCP_PINNED_SOFT_MAX = 12

export function allocateBudgetShares(window: number): Record<keyof BudgetLayerShares, number> {
  const system = Math.floor(window * BUDGET_SHARES.system)
  const tools = Math.floor(window * BUDGET_SHARES.tools)
  const memoryWorkspace = Math.floor(window * BUDGET_SHARES.memoryWorkspace)
  const history = Math.floor(window * BUDGET_SHARES.history)
  const buffer = Math.floor(window * BUDGET_SHARES.buffer)
  return {
    system,
    tools,
    memoryWorkspace,
    history,
    buffer: buffer + (window - (system + tools + memoryWorkspace + history + buffer))
  }
}

/** Non-buffer budget (85% of raw window). */
export function contentWindowFromRaw(window: number): number {
  const b = allocateBudgetShares(window)
  return b.system + b.tools + b.memoryWorkspace + b.history
}

export function compactionTriggerFromRaw(
  window: number,
  triggerRatio = DEFAULT_COMPACTION_TRIGGER_RATIO,
  softCap = COMPACTION_SOFT_CAP_TOKENS
): number {
  const ratioTrigger = Math.floor(contentWindowFromRaw(window) * triggerRatio)
  if (softCap <= 0) return ratioTrigger
  return Math.min(ratioTrigger, softCap)
}

/** Tools-layer budget after applying the soft schema-tax ceiling. */
export function toolsBudgetFromRaw(
  window: number,
  softCap = TOOLS_SOFT_CAP_TOKENS
): number {
  const share = allocateBudgetShares(window).tools
  if (softCap <= 0) return share
  return Math.min(share, softCap)
}
