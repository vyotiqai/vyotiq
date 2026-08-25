import { runCodebaseSearch } from '../codeindex'
import type { CodebaseSearchMode, CodeIndexEmbedderId } from '../codeindex'
import { DEFAULT_SEARCH_LIMIT, isHashEmbedderModelId } from '../codeindex/types'
import { logger } from '../../../shared/logger'

export { DEFAULT_SEARCH_LIMIT as CODEBASE_SEARCH_DEFAULT_LIMIT }

/** Warn once per process when semantic search silently degrades to lexical/hash. */
let hashFallbackWarned = false

/** Hybrid semantic + lexical codebase search over the local index. */
export async function toolCodebaseSearch(
  workspaceRoot: string,
  query: string,
  opts: {
    maxResults?: number
    mode?: CodebaseSearchMode
    refresh?: boolean
    signal?: AbortSignal
    /** @deprecated Prefer settings.codeIndex.embedder or embedderId. */
    preferOllama?: boolean
    embedderId?: CodeIndexEmbedderId
  } = {}
): Promise<string> {
  const q = query.trim()
  if (!q) throw new Error('codebase_search query is required')
  const { formatted, status, hits, queryModelId } = await runCodebaseSearch(workspaceRoot, q, {
    limit: opts.maxResults ?? DEFAULT_SEARCH_LIMIT,
    mode: opts.mode ?? 'hybrid',
    refresh: opts.refresh === true,
    signal: opts.signal,
    preferOllama: opts.preferOllama,
    embedderId: opts.embedderId
  })
  if (!status.ready && status.chunkCount === 0 && formatted.includes('disabled')) {
    return formatted
  }
  const hashFallback =
    isHashEmbedderModelId(status.modelId) || isHashEmbedderModelId(queryModelId)
  const queryIndexMismatch =
    !hashFallback &&
    queryModelId.trim() !== '' &&
    status.modelId.trim() !== '' &&
    queryModelId !== status.modelId
  const lexicalOnly = hashFallback || queryIndexMismatch
  if (hashFallback && !hashFallbackWarned) {
    hashFallbackWarned = true
    logger.warn('codeindex: semantic embeddings unavailable — results are lexical/hash only', {
      scope: 'codeindex'
    })
  }
  const fallbackNote = hashFallback ? ' · fallback=hash' : queryIndexMismatch ? ' · lexical-only' : ''
  const header = `index: ${status.chunkCount} chunks / ${status.fileCount} files · model=${status.modelId}${fallbackNote} · hits=${hits.length}`
  if (lexicalOnly) {
    const reason = hashFallback
      ? 'Neural embeddings are unavailable; hits are lexical/hash only (not dense semantic search).'
      : 'Query embedder does not match the indexed model; hits are lexical only (not dense semantic search).'
    return `${header}\n${reason}\n\n${formatted}`
  }
  return `${header}\n\n${formatted}`
}
