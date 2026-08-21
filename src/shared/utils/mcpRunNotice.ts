export function mcpToolsOmittedRunNotice(
  omittedCount: number,
  reason?: 'budget' | 'unpinned'
): string | undefined {
  if (omittedCount <= 0) return undefined
  if (reason === 'unpinned') {
    const n =
      omittedCount === 1
        ? '1 connected MCP tool is'
        : `${omittedCount} connected MCP tools are`
    return `${n} unpinned from this step catalog — the agent can list them with mcp_list_tools and pin with request_mcp_tools, or disable unused MCP servers in Marketplace → Manage.`
  }
  const n =
    omittedCount === 1 ? '1 MCP tool was' : `${omittedCount} MCP tools were`
  return `${n} deferred to fit the tools budget — the agent can pin tools with request_mcp_tools after releasing unused pins, or disable unused MCP servers in Marketplace → Manage.`
}
