import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import { countLines, splitLines } from './common'

export { countLines, splitLines } from './common'

export type EditCardData = {
  path: string
  added: number
  removed: number
  changeLabel: string
}

export type DiffLineKind = 'add' | 'del' | 'context' | 'gap'

export type DiffLine = {
  kind: DiffLineKind
  text: string
  lineNumber: number | null
}

export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

function changeLabelFor(added: number, removed: number): string {
  const parts: string[] = []
  if (added > 0) parts.push(`+${added}`)
  if (removed > 0) parts.push(`-${removed}`)
  return parts.join(' ')
}

function parseMultiEditCardData(
  args: Record<string, unknown> | null,
  summary: string | undefined
): EditCardData | null {
  const edits = args?.edits
  if (!Array.isArray(edits) || edits.length === 0) return null

  let added = 0
  let removed = 0
  const paths: string[] = []
  for (const entry of edits) {
    if (!entry || typeof entry !== 'object') continue
    const edit = entry as Record<string, unknown>
    if (typeof edit.path === 'string' && edit.path.trim()) paths.push(edit.path)
    if (typeof edit.contents === 'string') {
      added += countLines(edit.contents)
      continue
    }
    if (typeof edit.diff === 'string' && edit.diff.trim()) {
      const counts = countDiffLines(edit.diff)
      added += counts.added
      removed += counts.removed
    }
  }

  const path =
    paths.length > 1
      ? summary?.trim() || paths.join(', ')
      : paths[0] ?? (summary?.trim() || 'file')
  return { path, added, removed, changeLabel: changeLabelFor(added, removed) }
}

export function parseEditCardData(tool: UiToolRow): EditCardData {
  const args = parseArgsRecord(tool.argsPreview)
  const fromEdits = parseMultiEditCardData(args, tool.summary)
  if (fromEdits) return fromEdits

  const path = typeof args?.path === 'string' ? args.path : tool.summary?.trim() || 'file'

  if (tool.name === 'str_replace' || (typeof args?.old_string === 'string' && typeof args?.new_string === 'string')) {
    const oldString = typeof args?.old_string === 'string' ? args.old_string : ''
    const newString = typeof args?.new_string === 'string' ? args.new_string : ''
    if (oldString || newString) {
      const removed = countLines(oldString)
      const added = countLines(newString)
      return { path, added, removed, changeLabel: changeLabelFor(added, removed) }
    }
  }

  if (typeof args?.contents === 'string') {
    const added = countLines(args.contents)
    return { path, added, removed: 0, changeLabel: changeLabelFor(added, 0) }
  }

  if (typeof args?.diff === 'string' && args.diff.trim()) {
    const { added, removed } = countDiffLines(args.diff)
    return { path, added, removed, changeLabel: changeLabelFor(added, removed) }
  }

  return { path, added: 0, removed: 0, changeLabel: '' }
}

function diffLinesFromStrReplace(args: Record<string, unknown>): DiffLine[] {
  const oldString = typeof args.old_string === 'string' ? args.old_string : ''
  const newString = typeof args.new_string === 'string' ? args.new_string : ''
  if (!oldString && !newString) return []
  const out: DiffLine[] = []
  for (const text of splitLines(oldString)) {
    out.push({ kind: 'del', text, lineNumber: null })
  }
  for (const [index, text] of splitLines(newString).entries()) {
    out.push({ kind: 'add', text, lineNumber: index + 1 })
  }
  return out
}

function isUnifiedDiffMetadata(raw: string): boolean {
  return (
    raw.startsWith('diff --git') ||
    raw.startsWith('index ') ||
    raw.startsWith('new file mode') ||
    raw.startsWith('deleted file mode') ||
    raw.startsWith('old mode') ||
    raw.startsWith('new mode') ||
    raw.startsWith('similarity index') ||
    raw.startsWith('rename from') ||
    raw.startsWith('rename to') ||
    raw.startsWith('copy from') ||
    raw.startsWith('copy to') ||
    raw.startsWith('Binary files ')
  )
}

function diffLinesFromEditArgs(
  args: Record<string, unknown>,
  maxLines?: number
): DiffLine[] {
  if (typeof args.old_string === 'string' || typeof args.new_string === 'string') {
    const lines = diffLinesFromStrReplace(args)
    return typeof maxLines === 'number' && lines.length > maxLines
      ? lines.slice(0, maxLines)
      : lines
  }

  if (typeof args.contents === 'string') {
    const lines = splitLines(args.contents).map((text, index) => ({
      kind: 'add' as const,
      text,
      lineNumber: index + 1
    }))
    return typeof maxLines === 'number' && lines.length > maxLines
      ? lines.slice(0, maxLines)
      : lines
  }

  const diff = typeof args.diff === 'string' ? args.diff : ''
  if (!diff.trim()) return []

  // Avoid allocating/scanning a full 100k-char diff when the UI only shows a preview.
  const parseBudget =
    typeof maxLines === 'number' && maxLines > 0
      ? Math.min(diff.length, Math.max(16_000, maxLines * 400))
      : diff.length
  const text = parseBudget < diff.length ? diff.slice(0, parseBudget) : diff

  const out: DiffLine[] = []
  let lineNumber = 0
  const limit = typeof maxLines === 'number' && maxLines > 0 ? maxLines : Number.POSITIVE_INFINITY

  for (const raw of text.split('\n')) {
    if (out.length >= limit) break
    if (raw.startsWith('+++') || raw.startsWith('---')) continue
    if (isUnifiedDiffMetadata(raw)) continue

    const hunk = raw.match(/^@@\s*-\d+(?:,\d+)?\s*\+(\d+)/)
    if (hunk) {
      if (out.length > 0) out.push({ kind: 'gap', text: '', lineNumber: null })
      lineNumber = Number(hunk[1])
      continue
    }

    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), lineNumber })
      lineNumber += 1
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), lineNumber: null })
    } else if (raw.startsWith('\\')) {
      continue
    } else {
      out.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw, lineNumber })
      lineNumber += 1
    }
  }

  while (out.length > 0 && out[out.length - 1]!.kind === 'gap') out.pop()
  return out
}

/** Parse a unified diff string into preview lines (shared by edit + git_diff). */
export function parseUnifiedDiff(diff: string, maxLines?: number): DiffLine[] {
  if (!diff.trim()) return []
  return diffLinesFromEditArgs({ diff }, maxLines)
}

export function parseDiffPreview(tool: UiToolRow): DiffLine[] {
  const args = parseArgsRecord(tool.argsPreview)
  const edits = args?.edits
  if (Array.isArray(edits) && edits.length > 0) {
    const out: DiffLine[] = []
    for (const entry of edits) {
      if (!entry || typeof entry !== 'object') continue
      const edit = entry as Record<string, unknown>
      const chunk = diffLinesFromEditArgs(edit)
      if (!chunk.length) continue
      if (out.length > 0) out.push({ kind: 'gap', text: '', lineNumber: null })
      if (typeof edit.path === 'string' && edit.path.trim()) {
        out.push({ kind: 'context', text: edit.path, lineNumber: null })
      }
      out.push(...chunk)
    }
    return out
  }
  return diffLinesFromEditArgs(args ?? {})
}

export type FileChange = { path: string; added: number; removed: number }

function changeFromEditArgs(edit: Record<string, unknown>): FileChange | null {
  const path = typeof edit.path === 'string' ? edit.path : ''
  if (!path) return null
  if (typeof edit.contents === 'string') {
    const added = countLines(edit.contents)
    if (added > 0) return { path, added, removed: 0 }
    return null
  }
  if (typeof edit.diff === 'string' && edit.diff.trim()) {
    const { added, removed } = countDiffLines(edit.diff)
    if (added > 0 || removed > 0) return { path, added, removed }
  }
  return null
}

/** Per-file line deltas for turn change summaries. */
export function collectWritingChanges(tool: UiToolRow): FileChange[] {
  const args = parseArgsRecord(tool.argsPreview)
  if (tool.name === 'multi_edit') {
    const edits = args?.edits
    if (!Array.isArray(edits)) return []
    const out: FileChange[] = []
    for (const entry of edits) {
      if (!entry || typeof entry !== 'object') continue
      const change = changeFromEditArgs(entry as Record<string, unknown>)
      if (change) out.push(change)
    }
    return out
  }
  const { path, added, removed } = parseEditCardData(tool)
  if (!path || (added === 0 && removed === 0)) return []
  return [{ path, added, removed }]
}
