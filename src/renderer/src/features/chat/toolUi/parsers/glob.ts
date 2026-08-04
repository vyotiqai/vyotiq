import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type GlobParsed = {
  pattern: string
  paths: string[]
  truncated: boolean
}

export function parseGlobData(tool: UiToolRow): GlobParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const pattern =
    typeof args?.pattern === 'string' ? args.pattern : tool.summary?.trim() || ''
  const content = tool.content ?? ''

  if (content.startsWith('No files match')) {
    return { pattern, paths: [], truncated: false }
  }

  const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('…'))
  const truncated = content.includes('more (raise maxResults')
  return { pattern, paths: lines, truncated }
}
