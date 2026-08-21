import { openSync, readSync, closeSync, fstatSync } from 'fs'
import { join } from 'path'
import { cosineSimilarity, type Embedder } from './embed'
import { reciprocalRankFusion } from './rrf'
import type { CodeIndexStore } from './store'
import {
  CODE_INDEX_MAX_FILE_BYTES,
  DEFAULT_SEARCH_LIMIT,
  denseModelIdsCompatible,
  isHashEmbedderModelId,
  type CodebaseSearchHit,
  type CodebaseSearchMode
} from './types'
import { throwIfAborted, yieldToEventLoop } from '../tools/walk'

export type SearchOptions = {
  limit?: number
  mode?: CodebaseSearchMode
  signal?: AbortSignal
}

const DENSE_YIELD_EVERY = 256
/** Cap bytes read when extracting a line-bounded snippet (match indexed-file max). */
const SNIPPET_READ_CAP_BYTES = CODE_INDEX_MAX_FILE_BYTES

export type ScoredId = { id: number; score: number }

export function storeEmbeddingsMatchEmbedder(
  store: { dimensions: number; getMeta: (key: string) => string | null },
  embedder: Embedder
): boolean {
  const storeModel = store.getMeta('modelId')
  const storeDimsRaw = store.getMeta('dimensions')
  if (storeDimsRaw != null && storeDimsRaw.trim() !== '') {
    const storeDims = Number(storeDimsRaw)
    if (Number.isFinite(storeDims) && embedder.dimensions !== storeDims) return false
  } else if (embedder.dimensions !== store.dimensions) {
    return false
  }
  if (storeModel == null || storeModel.trim() === '') {
    // Missing meta: do not cosine-compare against unknown blobs.
    return false
  }
  if (!denseModelIdsCompatible(storeModel, embedder.modelId)) return false
  return true
}

/** Descending top-k without sorting the full corpus. */
export function insertTopK(top: ScoredId[], id: number, score: number, k: number): void {
  if (k <= 0) return
  if (top.length < k) {
    top.push({ id, score })
    top.sort((a, b) => b.score - a.score)
    return
  }
  const worst = top[top.length - 1]!
  if (score <= worst.score) return
  top[top.length - 1] = { id, score }
  top.sort((a, b) => b.score - a.score)
}

/** Dense top-k with periodic event-loop yields. */
export async function streamDenseTopK(
  store: CodeIndexStore,
  queryVec: Float32Array,
  k: number,
  signal?: AbortSignal
): Promise<ScoredId[]> {
  const top: ScoredId[] = []
  let i = 0
  for (const row of store.iterateEmbeddings()) {
    if (i > 0 && i % DENSE_YIELD_EVERY === 0) {
      await yieldToEventLoop()
      throwIfAborted(signal)
    }
    insertTopK(top, row.id, cosineSimilarity(queryVec, row.embedding), k)
    i++
  }
  return top
}

/**
 * Read only enough of the file to cover `[startLine, endLine]` instead of the
 * full source (up to 512KB). Falls back to empty string on any I/O error.
 */
function readSnippet(
  workspaceRoot: string,
  path: string,
  startLine: number,
  endLine: number,
  maxChars = 900
): string {
  try {
    const full = join(workspaceRoot, ...path.split('/'))
    const fd = openSync(full, 'r')
    try {
      const size = fstatSync(fd).size
      const toRead = Math.min(size, SNIPPET_READ_CAP_BYTES)
      const buf = Buffer.allocUnsafe(toRead)
      const n = readSync(fd, buf, 0, toRead, 0)
      const text = buf.toString('utf8', 0, n).replace(/\r\n/g, '\n')
      const lines = text.split('\n')
      const from = Math.max(0, startLine - 1)
      const to = Math.max(from, endLine)
      const slice = lines.slice(from, to).join('\n')
      return slice.length > maxChars ? slice.slice(0, maxChars) + '\n…' : slice
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

export async function searchCodeIndex(
  workspaceRoot: string,
  store: CodeIndexStore,
  embedder: Embedder,
  query: string,
  opts: SearchOptions = {}
): Promise<CodebaseSearchHit[]> {
  throwIfAborted(opts.signal)
  const q = query.trim()
  if (!q) return []

  const limit = Math.max(1, opts.limit ?? DEFAULT_SEARCH_LIMIT)
  const mode: CodebaseSearchMode = opts.mode ?? 'hybrid'
  const candidateCap = Math.max(limit * 4, 20)
  const hashFallback = isHashEmbedderModelId(embedder.modelId)
  const compatible = storeEmbeddingsMatchEmbedder(store, embedder)

  const denseIds: string[] = []
  const lexicalIds: string[] = []

  // Hash cosine is a weak bag-of-tokens signal; fusing it with FTS in hybrid
  // demotes real lexical hits. Keep dense only for neural models, or when the
  // caller asked for semantic mode explicitly — and only when the query
  // embedder matches the vectors already in SQLite.
  const useDense =
    compatible &&
    (mode === 'semantic' || (mode === 'hybrid' && !hashFallback))
  // Semantic with a mismatched/hash-fallback embedder still has FTS.
  const useLexical = mode === 'lexical' || mode === 'hybrid' || !useDense

  if (useDense) {
    const [qVec] = await embedder.embed([q], { role: 'query', signal: opts.signal })
    throwIfAborted(opts.signal)
    if (qVec) {
      const top = await streamDenseTopK(store, qVec, candidateCap, opts.signal)
      for (const s of top) denseIds.push(String(s.id))
    }
  }

  if (useLexical) {
    const ids = store.searchFts(q, candidateCap)
    for (const id of ids) lexicalIds.push(String(id))
  }

  let fused: { id: string; score: number }[]
  switch (mode) {
    case 'semantic':
      fused = (useDense ? denseIds : lexicalIds).map((id, i) => ({ id, score: 1 / (i + 1) }))
      break
    case 'lexical':
      fused = lexicalIds.map((id, i) => ({ id, score: 1 / (i + 1) }))
      break
    case 'hybrid':
      fused = hashFallback || !useDense
        ? lexicalIds.map((id, i) => ({ id, score: 1 / (i + 1) }))
        : reciprocalRankFusion([denseIds, lexicalIds])
      break
    default: {
      const _exhaustive: never = mode
      throw new Error(`unhandled codebase search mode: ${_exhaustive}`)
    }
  }

  const hits: CodebaseSearchHit[] = []
  for (const item of fused) {
    if (hits.length >= limit) break
    const chunk = store.getChunk(Number(item.id))
    if (!chunk) continue
    hits.push({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      kind: chunk.kind,
      name: chunk.name,
      parentName: chunk.parentName,
      score: item.score,
      snippet: readSnippet(workspaceRoot, chunk.path, chunk.startLine, chunk.endLine)
    })
  }
  return hits
}

export function formatSearchHits(hits: CodebaseSearchHit[]): string {
  if (!hits.length) return 'No codebase_search hits.'
  return hits
    .map((h, i) => {
      const parent = h.parentName ? ` (${h.parentName})` : ''
      const head = `${i + 1}. ${h.path}:${h.startLine}-${h.endLine} [${h.kind} ${h.name}${parent}] score=${h.score.toFixed(4)}`
      return `${head}\n${h.snippet}`
    })
    .join('\n\n')
}

const HIT_HEAD = /^(\d+)\.\s+(.+?):(\d+)-(\d+)\s+\[/

/** Concrete hit paths from a formatted codebase_search tool result. */
export function codebaseSearchHitPathsFromResult(content: string): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    const m = line.trim().match(HIT_HEAD)
    if (!m) continue
    const path = m[2]!
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}
