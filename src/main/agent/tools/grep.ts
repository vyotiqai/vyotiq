import { readFileSync, statSync } from 'fs'
import { extname } from 'path'
import { assertInsideWorkspace } from '../../../shared/workspacePath'
import {
  collectWorkspaceFiles,
  globToRegExp,
  TEXT_EXTS,
  throwIfAborted,
  yieldToEventLoop
} from './walk'
import { compileUserRegex } from './safeUserRegex'

export const GREP_SCAN_CAP = 20_000
export const GREP_MAX_FILE_BYTES = 512 * 1024
const SCAN_CAP = GREP_SCAN_CAP
const MAX_FILE_BYTES = GREP_MAX_FILE_BYTES
const YIELD_EVERY_FILES = 32
/** Matched line text clipped to this many characters in the report. */
export const GREP_MAX_LINE_CHARS = 400
const MAX_LINE_CHARS = GREP_MAX_LINE_CHARS

export type GrepOptions = {
  /** Glob restricting which files are searched, e.g. `src/**\/*.ts`. */
  include?: string
  caseSensitive?: boolean
  contextLines?: number
  maxResults?: number
}

function compile(pattern: string, caseSensitive: boolean): RegExp {
  return compileUserRegex(pattern, caseSensitive ? 'g' : 'gi')
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
}

/**
 * Regex content search with optional surrounding context.
 *
 * Distinct from `search`, which also matches file names and stops at the first
 * hit per file — grep reports every matching line so the model can judge scope.
 */
export async function toolGrep(
  workspaceRoot: string,
  pattern: string,
  options: GrepOptions = {},
  signal?: AbortSignal
): Promise<string> {
  const trimmed = pattern.trim()
  if (!trimmed) throw new Error('grep requires a non-empty pattern')

  const maxResults = Math.max(1, options.maxResults ?? 60)
  const contextLines = Math.max(0, Math.min(5, options.contextLines ?? 0))
  const includeRegex = options.include ? globToRegExp(options.include) : null

  assertInsideWorkspace(workspaceRoot, '.')
  const files = await collectWorkspaceFiles(workspaceRoot, SCAN_CAP, signal)
  throwIfAborted(signal)

  const out: string[] = []
  let matchCount = 0
  let truncated = false

  for (let i = 0; i < files.length && !truncated; i++) {
    throwIfAborted(signal)
    if (i > 0 && i % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
      throwIfAborted(signal)
    }

    const { full, rel } = files[i]!
    if (includeRegex && !includeRegex.test(rel)) continue
    if (!TEXT_EXTS.has(extname(full).toLowerCase())) continue

    let text: string
    try {
      if (statSync(full).size > MAX_FILE_BYTES) continue
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }

    // A fresh regex per file: `lastIndex` on a global regex leaks across files.
    const regex = compile(trimmed, options.caseSensitive === true)
    if (!regex.test(text)) continue

    const lines = text.split('\n')
    for (let n = 0; n < lines.length; n++) {
      const lineRegex = compile(trimmed, options.caseSensitive === true)
      if (!lineRegex.test(lines[n]!)) continue

      if (matchCount >= maxResults) {
        truncated = true
        break
      }
      matchCount++

      if (contextLines === 0) {
        out.push(`${rel}:${n + 1}: ${clip(lines[n]!.trim())}`)
        continue
      }
      const from = Math.max(0, n - contextLines)
      const to = Math.min(lines.length - 1, n + contextLines)
      out.push(`${rel}:${n + 1}`)
      for (let c = from; c <= to; c++) {
        out.push(`${c === n ? '>' : ' '} ${c + 1}| ${clip(lines[c]!)}`)
      }
      out.push('')
    }
  }

  if (matchCount === 0) return `No matches for /${trimmed}/`
  const suffix = truncated ? `\n… stopped at ${maxResults} matches` : ''
  return `${out.join('\n').trimEnd()}${suffix}`
}
