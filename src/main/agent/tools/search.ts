import { assertInsideWorkspace } from '../../../shared/workspacePath'
import { readFileSync, statSync } from 'fs'
import { extname } from 'path'
import {
  collectWorkspaceFilesPage,
  formatLiveScanCapNotice,
  TEXT_EXTS,
  throwIfAborted,
  yieldToEventLoop,
  type WalkedFile
} from './walk'
import { compileUserRegex } from './safeUserRegex'
import {
  querySparseCandidates,
  resolveCandidateFullPaths
} from '../sparsegrep'

const YIELD_EVERY_FILES = 32
export const SEARCH_SCAN_CAP = 5000
export const SEARCH_MAX_FILE_BYTES = 256 * 1024
export const SEARCH_DEFAULT_MAX_RESULTS = 40

function contentHit(
  file: string,
  rel: string,
  q: string,
  pattern: RegExp,
  regex: boolean
): string | null {
  try {
    statSync(file)
    const text = readFileSync(file, 'utf8')
    if (regex) {
      const match = pattern.exec(text)
      if (!match) return null
      const idx = match.index
      const line = text.slice(0, idx).split('\n').length
      const snippet = text.split('\n')[line - 1]?.trim() ?? ''
      return `${rel}:${line}: ${snippet}`
    }
    const idx = text.toLowerCase().indexOf(q.toLowerCase())
    if (idx < 0) return null
    const line = text.slice(0, idx).split('\n').length
    const snippet = text.split('\n')[line - 1]?.trim() ?? ''
    return `${rel}:${line}: ${snippet}`
  } catch {
    return null
  }
}

/** Case-insensitive substring or optional regex search over filenames and text contents. */
export async function toolSearch(
  workspaceRoot: string,
  query: string,
  maxResults?: number,
  signal?: AbortSignal,
  regex = false,
  scanCap?: number
): Promise<string> {
  throwIfAborted(signal)
  const q = query.trim()
  if (!q) throw new Error('search query is required')
  const limit =
    maxResults == null ? Number.POSITIVE_INFINITY : Math.max(1, maxResults)

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

  const hits: string[] = []
  const fileHitRels = new Set<string>()
  let truncated = false
  let indexMode: 'trigram' | 'live' = 'live'

  const liveCap =
    typeof scanCap === 'number' && Number.isFinite(scanCap)
      ? Math.max(1, Math.floor(scanCap))
      : SEARCH_SCAN_CAP
  const page = await collectWorkspaceFilesPage(workspaceRoot, liveCap, undefined, signal)
  const allFiles = page.files
  const liveHitCap = !page.exhausted
  throwIfAborted(signal)

  for (const f of allFiles) {
    if (Number.isFinite(limit) && hits.length >= limit) {
      truncated = true
      break
    }
    if (pattern.test(f.rel)) {
      hits.push(`file: ${f.rel}`)
      fileHitRels.add(f.rel)
    }
  }

  if (Number.isFinite(limit) && hits.length >= limit) {
    truncated = true
  } else {
    let contentFiles: WalkedFile[]
    const sparse = await querySparseCandidates(workspaceRoot, {
      query: q,
      kind: regex ? 'regex' : 'substring',
      caseSensitive: false,
      signal
    })
    if (sparse?.lookup.ok) {
      indexMode = 'trigram'
      contentFiles = resolveCandidateFullPaths(workspaceRoot, sparse.lookup.paths).filter(
        (f) => !fileHitRels.has(f.rel)
      )
    } else {
      contentFiles = allFiles.filter((f) => !fileHitRels.has(f.rel))
    }

    for (let i = 0; i < contentFiles.length; i++) {
      throwIfAborted(signal)
      if (i > 0 && i % YIELD_EVERY_FILES === 0) {
        await yieldToEventLoop()
        throwIfAborted(signal)
      }
      if (Number.isFinite(limit) && hits.length >= limit) {
        truncated = true
        break
      }
      const { full: file, rel } = contentFiles[i]!
      const ext = extname(file).toLowerCase()
      if (!TEXT_EXTS.has(ext)) continue
      const hit = contentHit(file, rel, q, pattern, regex)
      if (hit) hits.push(hit)
    }
  }

  const notices: string[] = []
  if (truncated) notices.push(`… stopped at ${limit} matches`)
  if (liveHitCap) notices.push(formatLiveScanCapNotice(liveCap))
  notices.push(`index=${indexMode}`)
  if (hits.length === 0) {
    return [`No matches for "${query}"`, ...notices].join('\n')
  }
  return [hits.join('\n'), ...notices].join('\n')
}

/** Paths from a successful `search` tool result (filename or content hits). */
export function searchHitPathsFromResult(content: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('…') || trimmed.startsWith('index=') || trimmed.startsWith('scan cap')) continue
    const fileHit = trimmed.match(/^file:\s*(.+)$/)
    if (fileHit) {
      const p = fileHit[1]!.trim()
      if (p && !seen.has(p)) {
        seen.add(p)
        out.push(p)
      }
      continue
    }
    const contentHit = trimmed.match(/^(.+?):(\d+):\s*(.*)$/)
    if (contentHit) {
      const p = contentHit[1]!.trim()
      if (p && !seen.has(p)) {
        seen.add(p)
        out.push(p)
      }
    }
  }
  return out
}
