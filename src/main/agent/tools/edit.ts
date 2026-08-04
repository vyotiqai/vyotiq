import { resolveInsideWorkspace, assertResolvedInsideWorkspace } from '../../workspace/safePath'
import { mkdirSync, readFileSync, existsSync } from 'fs'
import { dirname } from 'path'
import { atomicWriteFile } from '@main/storage/atomicWrite'

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

type HunkLine = { tag: ' ' | '-' | '+'; content: string }

type Hunk = {
  oldStart: number
  lines: HunkLine[]
}

function parseHunks(diff: string): Hunk[] {
  const diffLines = normalizeNewlines(diff).split('\n')
  const hunks: Hunk[] = []
  let i = 0

  while (i < diffLines.length) {
    const header = diffLines[i]
    if (
      header.startsWith('diff ') ||
      header.startsWith('index ') ||
      header.startsWith('---') ||
      header.startsWith('+++') ||
      header.startsWith('new file') ||
      header.startsWith('deleted file')
    ) {
      i++
      continue
    }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
    if (!match) {
      i++
      continue
    }

    const oldStart = Math.max(0, Number(match[1]) - 1)
    i++
    const lines: HunkLine[] = []

    while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
      const line = diffLines[i]
      if (
        line.startsWith('diff ') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('index ')
      ) {
        break
      }
      if (line.startsWith('\\')) {
        i++
        continue
      }

      const tag = line[0]
      if (tag === ' ' || tag === '-' || tag === '+') {
        lines.push({ tag, content: line.slice(1) })
      } else if (line === '') {
        lines.push({ tag: ' ', content: '' })
      } else {
        // Models sometimes omit the leading marker — treat as context.
        lines.push({ tag: ' ', content: line })
      }
      i++
    }

    hunks.push({ oldStart, lines })
  }

  return hunks
}

function matchesAt(lines: string[], pos: number, expected: string[]): boolean {
  if (expected.length === 0) return pos >= 0 && pos <= lines.length
  if (pos < 0 || pos + expected.length > lines.length) return false
  for (let j = 0; j < expected.length; j++) {
    if (lines[pos + j] !== expected[j]) return false
  }
  return true
}

function findHunkStart(lines: string[], hunk: Hunk): number {
  const expected = hunk.lines
    .filter((l) => l.tag === ' ' || l.tag === '-')
    .map((l) => l.content)

  if (matchesAt(lines, hunk.oldStart, expected)) return hunk.oldStart

  // Prefer declared line ± small radius only (avoid silent wrong-block applies).
  const radius = 40
  const nearMatches: number[] = []
  for (let d = 1; d <= radius; d++) {
    if (matchesAt(lines, hunk.oldStart + d, expected)) nearMatches.push(hunk.oldStart + d)
    if (matchesAt(lines, hunk.oldStart - d, expected)) nearMatches.push(hunk.oldStart - d)
  }
  if (nearMatches.length === 1) return nearMatches[0]
  if (nearMatches.length > 1) {
    throw new Error(
      `Diff hunk near line ${hunk.oldStart + 1} matched ${nearMatches.length} locations; re-read the file and provide a more unique context`
    )
  }

  if (expected.length === 0) {
    return Math.min(Math.max(0, hunk.oldStart), lines.length)
  }

  const globalMatches: number[] = []
  for (let pos = 0; pos <= lines.length - expected.length; pos++) {
    if (matchesAt(lines, pos, expected)) globalMatches.push(pos)
  }
  if (globalMatches.length === 1) return globalMatches[0]
  if (globalMatches.length > 1) {
    throw new Error(
      `Diff hunk for line ${hunk.oldStart + 1} matched ${globalMatches.length} places in the file; add more unique context lines`
    )
  }

  const preview = expected
    .slice(0, 3)
    .map((l) => `  ${JSON.stringify(l.slice(0, 100))}`)
    .join('\n')
  const around = lines
    .slice(Math.max(0, hunk.oldStart - 1), hunk.oldStart + 3)
    .map((l, i) => `  L${hunk.oldStart + i}: ${JSON.stringify(l.slice(0, 100))}`)
    .join('\n')
  throw new Error(
    `Diff hunk failed to match near line ${hunk.oldStart + 1} (context/removal mismatch).\nExpected:\n${preview}\nAround declared line:\n${around || '  (eof)'}`
  )
}

function applyHunk(lines: string[], hunk: Hunk): string[] {
  const start = findHunkStart(lines, hunk)
  const before = lines.slice(0, start)
  const out: string[] = []
  let cursor = start

  for (const { tag, content } of hunk.lines) {
    if (tag === ' ') {
      out.push(content)
      cursor++
    } else if (tag === '-') {
      cursor++
    } else {
      out.push(content)
    }
  }

  return [...before, ...out, ...lines.slice(cursor)]
}

/** Apply unified diff hunks; validates context and tolerates nearby drift. */
export function applyUnifiedDiff(original: string, diff: string): string {
  const hunks = parseHunks(diff)
  if (hunks.length === 0) {
    throw new Error('No unified-diff hunks found (need @@ headers)')
  }

  // Rejoin with the file's dominant EOL: normalizeNewlines is for matching
  // only — writing back LF would flip CRLF files on Windows.
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let lines = normalizeNewlines(original).split('\n')
  // Apply bottom-up so earlier original line numbers stay valid.
  for (const hunk of [...hunks].reverse()) {
    lines = applyHunk(lines, hunk)
  }
  return lines.join(eol)
}

export function toolEdit(
  workspaceRoot: string,
  pathArg: string,
  contents?: string,
  diff?: string
): string {
  if (!pathArg.trim()) throw new Error('edit requires a non-empty path')
  const resolved = resolveInsideWorkspace(workspaceRoot, pathArg)
  assertResolvedInsideWorkspace(workspaceRoot, dirname(resolved))
  mkdirSync(dirname(resolved), { recursive: true })
  assertResolvedInsideWorkspace(workspaceRoot, resolved)

  if (typeof contents === 'string') {
    atomicWriteFile(resolved, contents)
    return `Wrote ${pathArg} (${contents.length} chars)`
  }

  if (typeof diff === 'string' && diff.trim()) {
    const original = existsSync(resolved) ? readFileSync(resolved, 'utf8') : ''
    const next = applyUnifiedDiff(original, diff)
    atomicWriteFile(resolved, next)
    return `Applied diff to ${pathArg}`
  }

  throw new Error('edit requires contents or diff')
}
