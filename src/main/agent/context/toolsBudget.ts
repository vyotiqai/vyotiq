import type { ToolDefinition } from '../providers/types'
import { AGENT_TOOLS } from '../types'
import { estimateTextTokens } from './estimate'

/**
 * Always offered on a fresh catalog (must fit a 32k-window tools budget).
 * Core browse + diagnostics — no pin round-trip required.
 * Exotic browser tools (hover, wait-for-*) stay deferred and restore via sticky
 * after `request_mcp_tools` (Agent). Putting them here overflows the catalog
 * and the loop never streams.
 */
const CORE_OPTIONAL_ALWAYS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_scroll',
  'browser_tabs',
  'diagnostics'
])

/**
 * Deferred builtins — omitted from a fresh catalog; restore via sticky after
 * `request_mcp_tools` pins the name (same admission lag as MCP pins).
 */
export const OPTIONAL_BUILTIN_NAMES = new Set([
  ...AGENT_TOOLS.map((t) => t.name).filter(
    (name) => name.startsWith('browser_') && !CORE_OPTIONAL_ALWAYS.has(name)
  ),
  // Merge-back is rare vs spawn/await; defer to keep the 32k core catalog fitting.
  'merge_agent_instance'
])

export function isOptionalBuiltinName(name: string): boolean {
  return OPTIONAL_BUILTIN_NAMES.has(name)
}

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

export type BuildStepToolCatalogOptions = {
  pinnedMcpNames?: ReadonlySet<string>
  /**
   * When true (default), unpinned MCP tools are never kept in the step catalog.
   * Agents discover via mcp_list_tools and pin with request_mcp_tools.
   */
  deferUnpinnedMcp?: boolean
  /** Names kept on a prior step — restore that intersection in order. */
  stickyKeptNames?: ReadonlySet<string>
}

export type StepToolCatalog = {
  tools: ToolDefinition[]
  estimate: number
  omittedMcp: number
  omittedMcpNames: string[]
  budgetOmittedMcpNames: string[]
  /** Unpinned MCP tools omitted by deferUnpinnedMcp policy (not budget shed). */
  policyDeferredMcpNames: string[]
  evictedMcpNames: string[]
  fingerprint: string
}

export type BuildStepToolCatalogResult =
  | ({ ok: true } & StepToolCatalog)
  | {
      ok: false
      error: 'TOOLS_BUDGET_OVERFLOW'
      estimate: number
      omittedMcpNames: string[]
      budgetOmittedMcpNames: string[]
    }

/**
 * Build the step tool catalog with every builtin and MCP tool.
 * Never defers unpinned MCP, never evicts pins, never returns overflow.
 */
export function buildStepToolCatalog(
  tools: ToolDefinition[],
  _budgetTokens: number,
  _options?: BuildStepToolCatalogOptions
): BuildStepToolCatalogResult {
  const estimate = tools.reduce((n, t) => n + estimateToolDefTokens(t), 0)
  return {
    ok: true,
    tools,
    estimate,
    omittedMcp: 0,
    omittedMcpNames: [],
    budgetOmittedMcpNames: [],
    policyDeferredMcpNames: [],
    evictedMcpNames: [],
    fingerprint: toolCatalogFingerprint(tools)
  }
}

/** Optional builtins present in `available` but absent from the kept step catalog. */
export function omittedOptionalBuiltinNames(
  keptNames: ReadonlySet<string>,
  availableNames?: ReadonlySet<string>
): string[] {
  const out: string[] = []
  for (const name of OPTIONAL_BUILTIN_NAMES) {
    if (keptNames.has(name)) continue
    if (availableNames && !availableNames.has(name)) continue
    out.push(name)
  }
  return out.sort()
}

/**
 * Level-1 progressive disclosure for deferred builtins: name + short description.
 * Full schemas enter the provider catalog after request_mcp_tools + next step.
 */
export function loopHintForDeferredBuiltins(omittedNames: readonly string[]): string | undefined {
  if (omittedNames.length === 0) return undefined
  const byName = new Map(AGENT_TOOLS.map((t) => [t.name, t.description] as const))
  const lines = omittedNames.map((name) => {
    const desc = (byName.get(name) || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    return desc ? `- ${name}: ${desc}` : `- ${name}`
  })
  return [
    `${omittedNames.length} deferred built-in tool(s) are omitted from this step catalog:`,
    ...lines,
    'Pin with request_mcp_tools for the next step when needed; release_mcp_tools when finished.'
  ].join('\n')
}

/** Max tool lines in the deferred-MCP Level-1 hint (keeps loopHint small). */
export const DEFERRED_MCP_HINT_CAP = 12

/**
 * Level-1 progressive disclosure for unpinned connected MCP tools.
 * Full schemas enter the provider catalog after request_mcp_tools + next step.
 */
export function loopHintForDeferredMcpTools(
  deferredNames: readonly string[],
  tools?: ReadonlyArray<{ name: string; description?: string }>
): string | undefined {
  if (deferredNames.length === 0) return undefined
  const byName = new Map(
    (tools ?? []).map((t) => [t.name, (t.description || '').replace(/\s+/g, ' ').trim()] as const)
  )
  const shown = deferredNames.slice(0, DEFERRED_MCP_HINT_CAP)
  const lines = shown.map((name) => {
    const desc = (byName.get(name) || '').slice(0, 120)
    return desc ? `- ${name}: ${desc}` : `- ${name}`
  })
  const more = deferredNames.length - shown.length
  if (more > 0) {
    lines.push(`… +${more} more — call mcp_list_tools`)
  }
  return [
    `${deferredNames.length} connected MCP tool(s) are omitted from this step catalog (unpinned):`,
    ...lines,
    'Pin with request_mcp_tools for the next step when needed; release_mcp_tools when finished. Call mcp_list_tools for the full list.'
  ].join('\n')
}
