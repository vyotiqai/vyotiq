import { runCodebaseSearch } from '../codeindex'
import type { CodebaseSearchMode, CodeIndexEmbedderId } from '../codeindex'
import {
  DEFAULT_SEARCH_LIMIT,
  denseModelIdsCompatible,
  isHashEmbedderModelId
} from '../codeindex/types'
import { isAbortError } from '../../../shared/errors'
import { logger } from '../../../shared/logger'

export { DEFAULT_SEARCH_LIMIT as CODEBASE_SEARCH_DEFAULT_LIMIT }

/**
 * Why a codebase_search result degrades to lexical. True mismatch = cross-family /
 * incompatible stores. Same-family ids (e.g. stored DenseOn-ONNX vs resolved
 * mDenseOn) share an embedding space and the dense path already ran — those are
 * never labeled lexical-only. Hash on either side is always a fallback.
 */
export function codebaseSearchLexicalOnlyReason(
  statusModelId: string,
  queryModelId: string
): { hashFallback: boolean; queryIndexMismatch: boolean } {
  const hashFallback =
    isHashEmbedderModelId(statusModelId) || isHashEmbedderModelId(queryModelId)
  const queryIndexMismatch =
    !hashFallback &&
    queryModelId.trim() !== '' &&
    statusModelId.trim() !== '' &&
    !denseModelIdsCompatible(statusModelId, queryModelId)
  return { hashFallback, queryIndexMismatch }
}

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
  let result: Awaited<ReturnType<typeof runCodebaseSearch>>
  try {
    result = await runCodebaseSearch(workspaceRoot, q, {
      limit: opts.maxResults ?? DEFAULT_SEARCH_LIMIT,
      mode: opts.mode ?? 'hybrid',
      refresh: opts.refresh === true,
      signal: opts.signal,
      preferOllama: opts.preferOllama,
      embedderId: opts.embedderId
    })
  } catch (err) {
    // No hits could be produced at all (store absent, index empty, or the
    // dense embedder failed). Surface an actionable message instead of a raw
    // RPC error string; aborts rethrow.
    if (isAbortError(err) || opts.signal?.aborted) throw err
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn('codeindex: codebase_search produced no results', {
      scope: 'codeindex',
      reason
    })
    return `codebase_search unavailable: ${reason}. The index may still be warming or its embedder is unavailable — retry shortly or pass refresh:true to force a sync.`
  }
  const { formatted, status, hits, queryModelId } = result
  if (!status.ready && status.chunkCount === 0 && formatted.includes('disabled')) {
    return formatted
  }
  const { hashFallback, queryIndexMismatch } = codebaseSearchLexicalOnlyReason(
    status.modelId,
    queryModelId
  )
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
