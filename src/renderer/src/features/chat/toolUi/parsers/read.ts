import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import { splitLines } from './common'

export type ReadParsed = {
  path: string
  lineRange: string
  isDirectory: boolean
  lines: string[]
}

export function parseReadLineRange(tool: UiToolRow): string {
  const args = parseArgsRecord(tool.argsPreview)
  const start = typeof args?.startLine === 'number' ? args.startLine : null
  const end = typeof args?.endLine === 'number' ? args.endLine : null
  if (start != null || end != null) {
    return end == null ? `L${start}+` : `L${start ?? 1}-${end}`
  }
  if (tool.contentTruncated || !tool.content) return ''
  const lines = splitLines(tool.content)
  return lines.length > 0 ? `L1-${lines.length}` : ''
}

/** The body only renders a clamped preview — never retain past this many lines. */
export const READ_PARSE_LINE_BUDGET = 500

export function parseReadData(tool: UiToolRow): ReadParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const path = typeof args?.path === 'string' ? args.path : tool.summary?.trim() || ''
  const content = tool.content ?? ''
  const isDirectory = content.startsWith('Path is a directory')

  let lines: string[] = []
  if (!isDirectory && content) {
    lines = splitLines(content).slice(0, READ_PARSE_LINE_BUDGET)
  } else if (isDirectory) {
    const contentsIdx = content.indexOf('Contents:')
    if (contentsIdx >= 0) {
      const after = content.slice(contentsIdx + 'Contents:'.length).trim()
      lines = after
        .split('\n')
        .filter((l) => l.startsWith('[dir]') || l.startsWith('[file]'))
        .slice(0, READ_PARSE_LINE_BUDGET)
    }
  }

  return { path, lineRange: parseReadLineRange(tool), isDirectory, lines }
}
