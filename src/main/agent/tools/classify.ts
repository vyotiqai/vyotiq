/** Workspace-local reads safe to run concurrently (no file mutation). */
const PARALLEL_SAFE_BUILTIN = new Set([
  'read',
  'search',
  'glob',
  'grep',
  'list_dir',
  'memory_list',
  'memory_read',
  'Skill',
  'git_status',
  'git_diff',
  'mcp_list_tools'
])

/**
 * Tools that skip approval in `mutating` mode.
 * Same as parallel-safe except MCP catalog/meta builtins (`mcp_list_tools`, resources/prompts, pin tools).
 * Browser tools (including `browser_search`) are serial (shared BrowserWindow) and always gated.
 * Interactive gates (`ask_question`, `switch_mode`) have their own flow.
 */
const APPROVAL_EXEMPT_BUILTIN = new Set(
  [...PARALLEL_SAFE_BUILTIN].filter((name) => name !== 'mcp_list_tools')
)

/** Serial interactive tools — not parallel-safe, but not tool-approval gated. */
const SERIAL_APPROVAL_EXEMPT_BUILTIN = new Set(['ask_question', 'switch_mode'])

/**
 * Built-in tools safe to run in parallel (no workspace mutation).
 * MCP tools are never parallel-safe here — `readOnlyHint` is untrusted for
 * both parallelism and approval exemption. `mcp_list_tools` is the one catalog
 * builtin allowed to batch with reads.
 */
export function isParallelSafeTool(name: string): boolean {
  return PARALLEL_SAFE_BUILTIN.has(name)
}

/**
 * Tools that do not require approval when mode is `mutating`.
 * `browser_*` tools are serial-only and always gated (shared window + egress).
 * MCP builtins and MCP server tools always require approval in `mutating`/`all`.
 */
export function isApprovalExemptTool(name: string): boolean {
  return APPROVAL_EXEMPT_BUILTIN.has(name) || SERIAL_APPROVAL_EXEMPT_BUILTIN.has(name)
}

export const MAX_PARALLEL_READ_TOOLS = 4
