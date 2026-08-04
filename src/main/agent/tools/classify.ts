/** Workspace-local reads safe to run concurrently (no file mutation). */
const PARALLEL_SAFE_BUILTIN = new Set([
  'read',
  'search',
  'glob',
  'grep',
  'list_dir',
  'web_fetch',
  'web_search',
  'memory_list',
  'memory_read',
  'Skill',
  'git_status',
  'git_diff',
  'mcp_list_tools'
])

/**
 * Serial MCP meta tools — approval-exempt like mcp_list_tools, but not parallel-safe.
 * request/release mutate per-run pin state, so they must not batch with sibling calls.
 */
const MCP_SERIAL_APPROVAL_EXEMPT_BUILTIN = new Set([
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_list_prompts',
  'mcp_get_prompt',
  'request_mcp_tools',
  'release_mcp_tools'
])

/**
 * Tools that skip approval in `mutating` mode.
 * Same as parallel-safe except network egress (`web_fetch`, `web_search`).
 * Browser tools are serial (shared BrowserWindow) and always gated.
 * Interactive gates (`ask_question`, `switch_mode`) have their own flow.
 */
const APPROVAL_EXEMPT_BUILTIN = new Set([
  ...[...PARALLEL_SAFE_BUILTIN].filter((name) => name !== 'web_fetch' && name !== 'web_search'),
  ...MCP_SERIAL_APPROVAL_EXEMPT_BUILTIN
])

/** Serial interactive tools — not parallel-safe, but not tool-approval gated. */
const SERIAL_APPROVAL_EXEMPT_BUILTIN = new Set(['ask_question', 'switch_mode'])

/**
 * Built-in tools safe to run in parallel (no workspace mutation).
 * MCP tools are never parallel-safe here — `readOnlyHint` is untrusted for
 * both parallelism and approval exemption.
 */
export function isParallelSafeTool(name: string): boolean {
  return PARALLEL_SAFE_BUILTIN.has(name)
}

/**
 * Tools that do not require approval when mode is `mutating`.
 * `web_fetch` / `web_search` are parallel-safe but not approval-exempt (outbound network).
 * `browser_*` tools are serial-only and always gated (shared window + egress).
 * MCP tools always require approval in `mutating`/`all` — hint is untrusted.
 */
export function isApprovalExemptTool(name: string): boolean {
  return APPROVAL_EXEMPT_BUILTIN.has(name) || SERIAL_APPROVAL_EXEMPT_BUILTIN.has(name)
}

export const MAX_PARALLEL_READ_TOOLS = 4
