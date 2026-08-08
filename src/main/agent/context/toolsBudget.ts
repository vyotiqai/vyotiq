import type { ToolDefinition } from '../providers/types'
import { AGENT_TOOLS } from '../types'
import { MCP_TOOL_PREFIX } from '../mcp'
import { estimateTextTokens } from './estimate'
import { logger } from '../../../shared/logger'
import {
  MCP_PIN_IDLE_TTL_STEPS,
  MCP_PINNED_SOFT_MAX
} from '../../../shared/domain/contextBudget'

const BUILTIN_NAMES = new Set(AGENT_TOOLS.map((t) => t.name))

/**
 * Built-ins that may be shed (largest-first) so pinned/unpinned MCP can fit.
 * Core file/edit/search/MCP meta/memory tools stay required.
 */
const OPTIONAL_BUILTIN_NAMES = new Set(
  AGENT_TOOLS.map((t) => t.name).filter(
    (name) =>
      name.startsWith('browser_') ||
      name === 'browser_search' ||
      name === 'diagnostics' ||
      name === 'generate_image' ||
      name === 'edit_image'
  )
)

function estimateToolDefTokens(tool: ToolDefinition): number {
  try {
    return estimateTextTokens(JSON.stringify(tool))
  } catch {
    return 200
  }
}

/** Stable fingerprint of a kept tool catalog (names only, order-sensitive). */
export function toolCatalogFingerprint(tools: ReadonlyArray<{ name: string }>): string {
  return tools.map((t) => t.name).join('|')
}

export type TrimToolsOptions = {
  pinnedMcpNames?: ReadonlySet<string>
  /**
   * When true (default), unpinned MCP tools are never kept in the step catalog.
   * Agents discover via mcp_list_tools and pin with request_mcp_tools.
   */
  deferUnpinnedMcp?: boolean
  /**
   * Names kept on a prior step in this run. When set, restore that intersection
   * in order; newly pinned MCP may append (no reshuffle / no optional shedding).
   */
  stickyKeptNames?: ReadonlySet<string>
  /** Current agent step (1-based). Required for idle TTL / LRU eviction. */
  currentStep?: number
  /** Last step each MCP tool was pinned or invoked. */
  mcpLastUsedByName?: ReadonlyMap<string, number>
  /** Idle steps before a pinned MCP may be evicted (default MCP_PIN_IDLE_TTL_STEPS). */
  mcpPinIdleTtlSteps?: number
  /** Soft max pinned MCP in the catalog (default MCP_PINNED_SOFT_MAX). */
  mcpPinnedSoftMax?: number
}

export type TrimToolsResult = {
  tools: ToolDefinition[]
  estimate: number
  omittedMcp: number
  omittedMcpNames: string[]
  fingerprint: string
  /** MCP names removed from the sticky catalog this pass (idle TTL / soft max). */
  evictedMcpNames: string[]
}

/**
 * Choose pinned MCP names to drop from the catalog (idle TTL, then LRU soft max).
 * Never touches builtins. Pure helper for tests + sticky trim.
 */
export function selectMcpPinsToEvict(
  pinnedMcpInCatalog: readonly string[],
  opts: {
    currentStep: number
    lastUsedByName?: ReadonlyMap<string, number>
    idleTtlSteps?: number
    softMax?: number
  }
): string[] {
  if (pinnedMcpInCatalog.length === 0) return []
  const idleTtl = opts.idleTtlSteps ?? MCP_PIN_IDLE_TTL_STEPS
  const softMax = opts.softMax ?? MCP_PINNED_SOFT_MAX
  const lastUsed = opts.lastUsedByName
  const step = opts.currentStep

  const withAge = pinnedMcpInCatalog.map((name, index) => {
    const used = lastUsed?.get(name) ?? 0
    const idle = Math.max(0, step - used)
    return { name, idle, used, index }
  })

  const toEvict = new Set<string>()
  for (const row of withAge) {
    if (idleTtl > 0 && row.idle >= idleTtl) toEvict.add(row.name)
  }

  const remaining = withAge.filter((r) => !toEvict.has(r.name))
  if (softMax > 0 && remaining.length > softMax) {
    // LRU: lowest lastUsed first; stable by original index.
    const sorted = [...remaining].sort((a, b) => {
      if (a.used !== b.used) return a.used - b.used
      return a.index - b.index
    })
    const overflow = sorted.length - softMax
    for (let i = 0; i < overflow; i++) {
      toEvict.add(sorted[i]!.name)
    }
  }

  return pinnedMcpInCatalog.filter((n) => toEvict.has(n))
}

/**
 * Fit tool definitions into the tools token budget.
 * Required builtins stay; optional builtins may shed for MCP; pinned MCP preferred.
 * Unpinned MCP are deferred by default (pin via request_mcp_tools) — Claude Code practice.
 *
 * When `stickyKeptNames` is set (prior step's kept set), restore that catalog in
 * order (no optional shedding / no reshuffle). Newly pinned MCP tools are
 * **append-admitted** onto the sticky set so `request_mcp_tools` works mid-run
 * without rebuilding the whole catalog (defer_loading spirit; explicit prefix
 * growth only when pins change). Idle / over-soft-max pinned MCP may be
 * **evicted** (capability preserved via re-pin).
 */
export function trimToolsToBudget(
  tools: ToolDefinition[],
  budgetTokens: number,
  options?: TrimToolsOptions
): TrimToolsResult {
  const sticky = options?.stickyKeptNames
  if (sticky && sticky.size > 0) {
    return trimToolsSticky(tools, budgetTokens, sticky, options)
  }
  return trimToolsFresh(tools, budgetTokens, options)
}

function trimToolsFresh(
  tools: ToolDefinition[],
  budgetTokens: number,
  options?: TrimToolsOptions
): TrimToolsResult {
  const builtins = tools.filter((t) => BUILTIN_NAMES.has(t.name))
  const mcp = tools.filter((t) => t.name.startsWith(MCP_TOOL_PREFIX))
  const pinnedNames = options?.pinnedMcpNames
  const deferUnpinnedMcp = options?.deferUnpinnedMcp !== false

  const required = builtins.filter((t) => !OPTIONAL_BUILTIN_NAMES.has(t.name))
  const optional = builtins.filter((t) => OPTIONAL_BUILTIN_NAMES.has(t.name))

  let kept = [...required]
  let estimate = kept.reduce((n, t) => n + estimateToolDefTokens(t), 0)

  const pinned: ToolDefinition[] = []
  const unpinned: ToolDefinition[] = []
  for (const tool of mcp) {
    if (pinnedNames?.has(tool.name)) pinned.push(tool)
    else unpinned.push(tool)
  }

  const tryKeep = (tool: ToolDefinition): boolean => {
    const toolEst = estimateToolDefTokens(tool)
    if (estimate + toolEst <= budgetTokens) {
      kept.push(tool)
      estimate += toolEst
      return true
    }
    const overhead = estimateToolDefTokens({ ...tool, description: '' })
    const availableTokens = Math.max(0, budgetTokens - estimate - overhead)
    const truncated = truncateToolDescription(tool, Math.max(80, availableTokens))
    const truncEst = estimateToolDefTokens(truncated)
    if (estimate + truncEst <= budgetTokens) {
      kept.push(truncated)
      estimate += truncEst
      return true
    }
    return false
  }

  // Optional builtins first (may later be shed for MCP).
  for (const tool of optional) {
    tryKeep(tool)
  }

  // Pinned MCP first (agent-requested), then optional unpinned fill when not deferred.
  for (const tool of pinned) {
    if (tryKeep(tool)) continue
    if (shedOptionalBuiltinsFor(tool)) tryKeep(tool)
  }

  if (!deferUnpinnedMcp) {
    const sortedUnpinned = [...unpinned].sort(
      (a, b) => estimateToolDefTokens(a) - estimateToolDefTokens(b)
    )
    for (const tool of sortedUnpinned) {
      if (tryKeep(tool)) continue
      if (shedOptionalBuiltinsFor(tool)) tryKeep(tool)
    }
  }

  function shedOptionalBuiltinsFor(incoming: ToolDefinition): boolean {
    const need = estimateToolDefTokens(incoming)
    if (estimate + need <= budgetTokens) return true
    const optionalKept = kept
      .filter((t) => OPTIONAL_BUILTIN_NAMES.has(t.name))
      .sort((a, b) => estimateToolDefTokens(b) - estimateToolDefTokens(a))
    for (const drop of optionalKept) {
      const dropEst = estimateToolDefTokens(drop)
      kept = kept.filter((t) => t.name !== drop.name)
      estimate = Math.max(0, estimate - dropEst)
      if (estimate + need <= budgetTokens) return true
    }
    return estimate + need <= budgetTokens
  }

  const afterEvict = applyPinnedMcpEviction(kept, options)
  return finishResult(
    afterEvict.kept,
    mcp,
    budgetTokens,
    deferUnpinnedMcp,
    afterEvict.kept.reduce((n, t) => n + estimateToolDefTokens(t), 0),
    afterEvict.evictedMcpNames,
    options?.pinnedMcpNames
  )
}

function trimToolsSticky(
  tools: ToolDefinition[],
  budgetTokens: number,
  stickyKeptNames: ReadonlySet<string>,
  options?: TrimToolsOptions
): TrimToolsResult {
  const pinnedNames = options?.pinnedMcpNames
  const deferUnpinnedMcp = options?.deferUnpinnedMcp !== false
  const mcp = tools.filter((t) => t.name.startsWith(MCP_TOOL_PREFIX))
  const required = tools.filter(
    (t) => BUILTIN_NAMES.has(t.name) && !OPTIONAL_BUILTIN_NAMES.has(t.name)
  )

  // Preserve prior catalog order from the current tools list intersection.
  const keptNames = new Set<string>()
  const kept: ToolDefinition[] = []
  let estimate = 0

  const pushKeep = (tool: ToolDefinition): void => {
    if (keptNames.has(tool.name)) return
    kept.push(tool)
    keptNames.add(tool.name)
    estimate += estimateToolDefTokens(tool)
  }

  for (const tool of required) pushKeep(tool)

  for (const tool of tools) {
    if (!stickyKeptNames.has(tool.name)) continue
    if (keptNames.has(tool.name)) continue
    // Do not re-admit deferred unpinned MCP via sticky if pins were cleared.
    if (
      deferUnpinnedMcp &&
      tool.name.startsWith(MCP_TOOL_PREFIX) &&
      pinnedNames &&
      !pinnedNames.has(tool.name)
    ) {
      continue
    }
    pushKeep(tool)
  }

  // Append-admit newly pinned MCP without reshuffling prior sticky order or shedding
  // optionals (capability-preserving mid-run pin recovery). Soft budget like sticky restore.
  if (pinnedNames && pinnedNames.size > 0) {
    const admitted: string[] = []
    for (const tool of mcp) {
      if (!pinnedNames.has(tool.name) || keptNames.has(tool.name)) continue
      pushKeep(tool)
      admitted.push(tool.name)
    }
    if (admitted.length > 0) {
      logger.info('Sticky tool catalog admitted pinned MCP tools', {
        scope: 'agent',
        code: 'TOKEN_COST',
        admittedCount: admitted.length,
        admittedPreview: admitted.slice(0, 8).join(', ')
      })
    }
  }

  const afterEvict = applyPinnedMcpEviction(kept, options)
  // Prefer shedding optional builtins over blowing the tools soft cap every step.
  // Never drop required builtins or pinned MCP (pin recovery + prefix stability).
  const fitted = shedStickyOptionalsToBudget(afterEvict.kept, budgetTokens)
  return finishResult(
    fitted,
    mcp,
    budgetTokens,
    deferUnpinnedMcp,
    fitted.reduce((n, t) => n + estimateToolDefTokens(t), 0),
    afterEvict.evictedMcpNames,
    options?.pinnedMcpNames
  )
}

/** Drop optional builtins largest-first until estimate ≤ budget (sticky path). */
function shedStickyOptionalsToBudget(
  kept: ToolDefinition[],
  budgetTokens: number
): ToolDefinition[] {
  let estimate = kept.reduce((n, t) => n + estimateToolDefTokens(t), 0)
  if (estimate <= budgetTokens) return kept

  const optionalIndexes = kept
    .map((t, index) => ({ t, index, est: estimateToolDefTokens(t) }))
    .filter(({ t }) => OPTIONAL_BUILTIN_NAMES.has(t.name))
    .sort((a, b) => b.est - a.est || b.index - a.index)

  const drop = new Set<string>()
  for (const row of optionalIndexes) {
    if (estimate <= budgetTokens) break
    drop.add(row.t.name)
    estimate -= row.est
  }
  if (drop.size === 0) return kept
  logger.info('Shed optional builtins from sticky catalog to fit tools budget', {
    scope: 'agent',
    code: 'TOKEN_COST',
    shedCount: drop.size,
    shedPreview: [...drop].slice(0, 8).join(', '),
    budgetTokens,
    estimate
  })
  return kept.filter((t) => !drop.has(t.name))
}

function applyPinnedMcpEviction(
  kept: ToolDefinition[],
  options?: TrimToolsOptions
): { kept: ToolDefinition[]; evictedMcpNames: string[] } {
  const currentStep = options?.currentStep
  if (currentStep == null || currentStep < 1) {
    return { kept, evictedMcpNames: [] }
  }
  const mcpNames = kept
    .filter((t) => t.name.startsWith(MCP_TOOL_PREFIX))
    .map((t) => t.name)
  const evictedMcpNames = selectMcpPinsToEvict(mcpNames, {
    currentStep,
    lastUsedByName: options?.mcpLastUsedByName,
    idleTtlSteps: options?.mcpPinIdleTtlSteps,
    softMax: options?.mcpPinnedSoftMax
  })
  if (evictedMcpNames.length === 0) return { kept, evictedMcpNames: [] }
  const drop = new Set(evictedMcpNames)
  logger.info('Evicted idle / over-cap pinned MCP from tool catalog', {
    scope: 'agent',
    code: 'TOKEN_COST',
    evictedCount: evictedMcpNames.length,
    evictedPreview: evictedMcpNames.slice(0, 8).join(', '),
    currentStep
  })
  return {
    kept: kept.filter((t) => !drop.has(t.name)),
    evictedMcpNames
  }
}

function finishResult(
  kept: ToolDefinition[],
  mcp: ToolDefinition[],
  budgetTokens: number,
  deferUnpinnedMcp: boolean,
  estimate: number,
  evictedMcpNames: string[] = [],
  pinnedMcpNames?: ReadonlySet<string>
): TrimToolsResult {
  const keptMcpNames = new Set(
    kept.filter((t) => t.name.startsWith(MCP_TOOL_PREFIX)).map((t) => t.name)
  )
  const omittedMcpNames = mcp.map((t) => t.name).filter((n) => !keptMcpNames.has(n))
  const omittedMcp = omittedMcpNames.length
  const evicted = new Set(evictedMcpNames)
  // Policy-deferred unpinned MCP are omitted by design every step — only tools
  // that lost a real budget fight (pinned, or fill-mode candidates) warrant a warn.
  const budgetOmittedNames = (
    deferUnpinnedMcp ? omittedMcpNames.filter((n) => pinnedMcpNames?.has(n)) : omittedMcpNames
  ).filter((n) => !evicted.has(n))
  const policyDeferredNames = deferUnpinnedMcp
    ? omittedMcpNames.filter((n) => !pinnedMcpNames?.has(n))
    : []
  if (budgetOmittedNames.length > 0) {
    logger.warn('Pinned MCP tools omitted to fit tools budget', {
      scope: 'agent',
      code: 'CONTEXT_TOOLS_BUDGET',
      omittedMcp: budgetOmittedNames.length,
      budgetTokens,
      estimate,
      deferUnpinnedMcp,
      omittedPreview: budgetOmittedNames.slice(0, 10).join(', '),
      evictedMcp: evictedMcpNames.length
    })
  }
  if (policyDeferredNames.length > 0) {
    logger.debug('Unpinned MCP tools deferred from step catalog by policy', {
      scope: 'agent',
      code: 'CONTEXT_TOOLS_BUDGET',
      deferredMcp: policyDeferredNames.length,
      budgetTokens,
      estimate,
      deferredPreview: policyDeferredNames.slice(0, 10).join(', ')
    })
  }

  return {
    tools: kept,
    estimate,
    omittedMcp,
    omittedMcpNames,
    fingerprint: toolCatalogFingerprint(kept),
    evictedMcpNames
  }
}

function truncateToolDescription(
  tool: ToolDefinition,
  maxDescChars: number
): ToolDefinition {
  const desc = tool.description ?? ''
  if (desc.length <= maxDescChars) return tool
  return {
    ...tool,
    description: desc.slice(0, maxDescChars) + '…'
  }
}
