import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/ui'
import {
  TOOL_FAMILY_DELETE,
  TOOL_FAMILY_TERMINAL,
  TOOL_FAMILY_TODO
} from '@renderer/lib/utils/layout'

const FAMILY_TOOLS = new Set(['todo_write', 'delete', 'terminal'])

/** Family body chrome for compact tools. Edit/diff use bordered ToolCard instead. */
export function wrapFamilyShell(toolName: string, children: ReactNode): ReactNode {
  if (!FAMILY_TOOLS.has(toolName)) return children

  switch (toolName) {
    case 'terminal':
      return (
        <div className={cn(TOOL_FAMILY_TERMINAL)} data-tool-family="terminal">
          {children}
        </div>
      )
    case 'todo_write':
      return (
        <div className={cn(TOOL_FAMILY_TODO)} data-tool-family="todo">
          {children}
        </div>
      )
    case 'delete':
      return (
        <div className={cn(TOOL_FAMILY_DELETE)} data-tool-family="delete">
          {children}
        </div>
      )
    default:
      return children
  }
}

/**
 * File-read tools dump large payloads — keep the timeline as a compact path row.
 * Failures still auto-open so the error is visible without an extra click.
 */
const FILE_READ_TOOLS = new Set(['read', 'memory_read'])

export function isFileReadTool(name: string): boolean {
  return FILE_READ_TOOLS.has(name)
}

/**
 * Whether a tool body should auto-open in the transcript.
 * `live` keeps streaming tools open for the active turn, except file reads.
 */
export function toolDefaultExpanded(
  name: string,
  status: 'running' | 'done' | 'fail',
  live = false
): boolean {
  // File reads stay compact — path lives in the row; body is opt-in + clamped.
  // Failures still open so the error is visible without an extra click.
  if (FILE_READ_TOOLS.has(name)) return status === 'fail'
  if (name === 'todo_write') return true
  return live || status === 'running'
}

/** Checklist stays open so the strip is always readable. */
export function familyDefaultExpanded(name: string, status: 'running' | 'done' | 'fail'): boolean {
  return toolDefaultExpanded(name, status, false)
}
