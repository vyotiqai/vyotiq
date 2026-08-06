import { getWriteCheckpoint, type InvokeWriteCheckpoint } from '../checkpoints'

/** Official @modelcontextprotocol/server-filesystem write-capable tools. */
const FILESYSTEM_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'create_directory',
  'move_file'
])

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Snapshot known MCP filesystem write paths before invokeMcpTool.
 * Conservative: only bundled filesystem tool names + explicit path args.
 */
export function recordMcpFilesystemPriors(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  context: { runDir?: string; skipWriteCheckpoint?: boolean }
): void {
  if (context.skipWriteCheckpoint || !context.runDir) return
  // Match marketplace id "filesystem" and common short aliases used in tests (fs).
  const isFilesystemServer =
    serverId === 'filesystem' || serverId === 'fs' || /filesystem/i.test(serverId)
  if (!isFilesystemServer || !FILESYSTEM_WRITE_TOOLS.has(toolName)) return

  const cp = getWriteCheckpoint(context.runDir)
  if (!cp) return

  if (toolName === 'move_file') {
    const source = asString(args.source)
    const destination = asString(args.destination)
    if (source) cp.recordPrior(source, 'delete')
    if (destination) cp.recordPrior(destination, 'write')
    return
  }

  if (toolName === 'edit_file' && args.dryRun === true) return

  const path = asString(args.path)
  if (!path) return
  cp.recordPrior(path, 'write')
}

/** Test helper: expose the known write-tool set. */
export function mcpFilesystemWriteToolsForTests(): readonly string[] {
  return [...FILESYSTEM_WRITE_TOOLS]
}

export type { InvokeWriteCheckpoint }
