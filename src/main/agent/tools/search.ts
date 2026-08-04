import { assertInsideWorkspace } from '../../../shared/workspacePath'
import { readFileSync, statSync } from 'fs'
import { extname } from 'path'
import {
  collectWorkspaceFiles,
  TEXT_EXTS,
  throwIfAborted,
  yieldToEventLoop
} from './walk'
import { compileUserRegex } from './safeUserRegex'

const YIELD_EVERY_FILES = 32
/** Max workspace files walked for a search (smaller than glob/grep). */
export const SEARCH_SCAN_CAP = 5000
/** Content hits only in text files at or under this size. */
export const SEARCH_MAX_FILE_BYTES = 256 * 1024
export const SEARCH_DEFAULT_MAX_RESULTS = 40

/** Case-insensitive substring or optional regex search over filenames and text contents. */
export async function toolSearch(
  workspaceRoot: string,
  query: string,
  maxResults = SEARCH_DEFAULT_MAX_RESULTS,
  signal?: AbortSignal,
  regex = false
): Promise<string> {
  throwIfAborted(signal)
  const q = query.trim()
  if (!q) throw new Error('search query is required')

  let pattern: RegExp
  if (regex) {
    pattern = compileUserRegex(q, 'i')
  } else {
    const lower = q.toLowerCase()
    pattern = {
      test: (s: string) => s.toLowerCase().includes(lower)
    } as RegExp
  }

  assertInsideWorkspace(workspaceRoot, '.')
  const files = await collectWorkspaceFiles(workspaceRoot, SEARCH_SCAN_CAP, signal)
  throwIfAborted(signal)
  const scanCapped = files.length >= SEARCH_SCAN_CAP

  const hits: string[] = []
  let truncated = false

  for (let i = 0; i < files.length; i++) {
    throwIfAborted(signal)
    if (i > 0 && i % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
      throwIfAborted(signal)
    }
    if (hits.length >= maxResults) {
      truncated = true
      break
    }

    const { full: file, rel } = files[i]!
    if (pattern.test(rel)) {
      hits.push(`file: ${rel}`)
      continue
    }
    const ext = extname(file).toLowerCase()
    if (!TEXT_EXTS.has(ext)) continue
    try {
      const st = statSync(file)
      if (st.size > SEARCH_MAX_FILE_BYTES) continue
      const text = readFileSync(file, 'utf8')
      if (regex) {
        const match = pattern.exec(text)
        if (match) {
          const idx = match.index
          const line = text.slice(0, idx).split('\n').length
          const snippet = text.split('\n')[line - 1]?.trim().slice(0, 120) ?? ''
          hits.push(`${rel}:${line}: ${snippet}`)
        }
      } else {
        const idx = text.toLowerCase().indexOf(q.toLowerCase())
        if (idx >= 0) {
          const line = text.slice(0, idx).split('\n').length
          const snippet = text.split('\n')[line - 1]?.trim().slice(0, 120) ?? ''
          hits.push(`${rel}:${line}: ${snippet}`)
        }
      }
    } catch {
      // skip unreadable
    }
  }

  if (hits.length === 0) return `No matches for "${query}"`
  const notices: string[] = []
  if (truncated) notices.push(`… stopped at ${maxResults} matches`)
  if (scanCapped) notices.push(`… searched first ${SEARCH_SCAN_CAP} files only (scan cap)`)
  return [hits.join('\n'), ...notices].join('\n')
}
