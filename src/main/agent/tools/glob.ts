import { join } from 'path'
import { assertInsideWorkspace } from '../../../shared/workspacePath'
import { querySparseFileList } from '../sparsegrep'
import { collectWorkspaceFiles, globToRegExp, CODE_INDEX_EXTS, throwIfAborted, type WalkedFile } from './walk'

export const GLOB_SCAN_CAP = 20_000
export const GLOB_DEFAULT_MAX_RESULTS = 100

/** True when every extension the glob can match is in the source index. */
export function globPatternIsTextOnly(pattern: string, textExts: ReadonlySet<string> = CODE_INDEX_EXTS): boolean {
  const last = pattern.trim().replace(/\\/g, '/').split('/').pop() ?? ''
  if (!last) return false
  const brace = /(?:^|.*)\.\{([^}]+)\}$/.exec(last)
  if (brace) {
    const exts = brace[1]
      .split(',')
      .map((s) => {
        const t = s.trim().replace(/^\./, '')
        return t ? `.${t.toLowerCase()}` : ''
      })
      .filter(Boolean)
    return exts.length > 0 && exts.every((e) => textExts.has(e))
  }
  const dot = last.lastIndexOf('.')
  if (dot < 0) return false
  const ext = last.slice(dot).toLowerCase()
  if (!/^\.[a-z0-9]+$/.test(ext)) return false
  return textExts.has(ext)
}

/** List workspace files matching a glob, honouring .gitignore. */
export async function toolGlob(
  workspaceRoot: string,
  pattern: string,
  maxResults?: number,
  signal?: AbortSignal
): Promise<string> {
  const trimmed = pattern.trim()
  if (!trimmed) throw new Error('glob requires a non-empty pattern')

  assertInsideWorkspace(workspaceRoot, '.')
  const regex = globToRegExp(trimmed)
  const limit =
    maxResults == null ? Number.POSITIVE_INFINITY : Math.max(1, maxResults)

  let files: WalkedFile[] | undefined
  let indexMode: 'trigram' | 'live' = 'live'
  let indexSyncInProgress = false
  let indexedFileCount = 0

  const list = await querySparseFileList(workspaceRoot, { signal })
  if (list) {
    indexedFileCount = list.fileCount
    indexSyncInProgress = !list.syncComplete
    if (list.ready && (list.syncComplete || list.paths.length > 0) && globPatternIsTextOnly(trimmed)) {
      indexMode = 'trigram'
      files = list.paths.map((rel) => ({
        full: join(workspaceRoot, ...rel.split('/')),
        rel
      }))
      files.sort((a, b) => a.rel.localeCompare(b.rel))
    }
  }

  if (!files) {
    indexMode = 'live'
    files = await collectWorkspaceFiles(workspaceRoot, undefined, signal)
    throwIfAborted(signal)
  }

  const matches = files
    .map((file) => file.rel)
    .filter((rel) => regex.test(rel))
    .sort((a, b) => a.localeCompare(b))

  if (matches.length === 0) {
    const notices = [`No files match ${trimmed}`]
    if (indexSyncInProgress) {
      notices.push(`index sync in progress (${indexedFileCount} files indexed so far)`)
    }
    notices.push(`index=${indexMode}`)
    return notices.join('\n')
  }

  const shown = Number.isFinite(limit) ? matches.slice(0, limit) : matches
  const suffixParts: string[] = []
  if (matches.length > shown.length) {
    suffixParts.push(`… ${matches.length - shown.length} more (raise maxResults or narrow the pattern)`)
  }
  if (indexSyncInProgress) {
    suffixParts.push(`index sync in progress (${indexedFileCount} files indexed so far)`)
  }
  suffixParts.push(`index=${indexMode}`)
  const suffix = suffixParts.length > 0 ? `\n${suffixParts.join('\n')}` : ''
  return `${shown.join('\n')}${suffix}`
}
