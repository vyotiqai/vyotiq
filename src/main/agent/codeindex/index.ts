import { isAbortError } from '../../../shared/errors'
import {
  createLocalHashEmbedder,
  createOllamaEmbedder,
  type Embedder,
  type OllamaEmbedOptions
} from './embed'
import {
  createMDenseOnEmbedder,
  clearEmbedderFailCache,
  isEmbedderFailCached,
  rememberEmbedderFail,
  mDenseOnWeightsOnDisk,
  type MDenseOnEnsureOptions
} from './mdenseon'
import { CodeIndexStore, codeindexDbPath } from './store'
import { syncCodeIndex, type SyncResult } from './sync'
import type { WalkedFile } from '../tools/walk'
import { clearIndexSyncProgress } from './indexProgress'
import { searchCodeIndex, formatSearchHits } from './search'
import type {
  CodebaseSearchHit,
  CodebaseSearchMode,
  CodeIndexEmbedderId,
  IndexStatus
} from './types'
import {
  DEFAULT_EMBED_DIM,
  DEFAULT_MODEL_ID,
  MDENSEON_MODEL_ID,
  isHashEmbedderModelId
} from './types'
import { markCodeIndexEmbedder, setCodeIndexRuntimeStatus } from './modelStatus'
import { logger } from '../../../shared/logger'
import { enqueueIndexJob } from '../indexJobQueue'
import {
  canUseIndexSearchUtility,
  canUseIndexSyncUtility,
  getEmbedUtilityClient
} from './embedUtilityClient'

/** Debounce window (ms). */
export const CODEINDEX_SYNC_DEBOUNCE_MS = 1500

export type { CodeChunk, CodebaseSearchHit, CodebaseSearchMode, IndexStatus } from './types'
export type { CodeIndexEmbedderId, CodeIndexRuntimeStatus } from './types'
export { chunkSource } from './chunk'
export { chunkContentHash, sha256Text } from './hash'
export { clsPoolLastHidden, l2NormalizeInPlace } from './onnxEmbed'
export {
  chunkSourceAst,
  treeSitterReady,
  codeindexWasmCandidateDirs,
  resolveCodeindexWasmFile,
  disposeChunkParsers
} from './chunkAst'
export { reciprocalRankFusion } from './rrf'
export {
  createLocalHashEmbedder,
  createOllamaEmbedder,
  tokenizeForEmbed
} from './embed'
export {
  createMDenseOnEmbedder,
  ensureMDenseOnModel,
  clearMDenseOnSession,
  clearMDenseOnSessionForTests,
  clearEmbedderFailCache,
  clearEmbedderFailCacheForTests,
  setEmbedderFailCacheTtlMsForTests,
  isEmbedderFailCached,
  mDenseOnWeightsOnDisk
} from './mdenseon'
export type { OnnxEmbedSession, MDenseOnEnsureOptions, MDenseOnEmbedderOptions } from './mdenseon'
export {
  DEFAULT_EMBED_DIM,
  DEFAULT_MODEL_ID,
  MDENSEON_MODEL_ID,
  DENSEON_ONNX_MODEL_ID,
  LIGHTON_DENSE_DIM,
  CODE_INDEX_MAX_FILE_BYTES,
  isHashEmbedderModelId,
  isLightOnDenseModelId,
  denseModelIdsCompatible,
  shouldPreserveIndexedEmbeddings
} from './types'
export { CodeIndexStore, codeindexRoot, sanitizeFtsQuery, ftsQueryTokens, buildChunkFtsText } from './store'
export { syncCodeIndex, INDEX_SCAN_CAP, CODE_INDEX_EMBED_BATCH, CODE_INDEX_RECONCILE_WALK_CAP, embedLengthBucket } from './sync'
export { clearIndexSyncProgress, publishIndexSyncProgress } from './indexProgress'
export { searchCodeIndex, formatSearchHits, codebaseSearchHitPathsFromResult, insertTopK, streamDenseTopK, storeEmbeddingsMatchEmbedder } from './search'
export {
  buildOrtSessionOptions,
  resolveOrtIntraOpThreads
} from './ortSessionOptions'
export { getCodeIndexRuntimeStatus, onCodeIndexRuntimeStatus } from './modelStatus'
export { codeIndexModelsRoot, setCodeIndexModelsRootOverrideForTests } from './modelPaths'
export {
  downloadModelFiles,
  modelFilesPresent,
  denseOnOnnxFiles,
  mDenseOnOnnxFiles
} from './modelDownload'
export {
  canUseIndexSearchUtility,
  canUseIndexSyncUtility,
  getEmbedUtilityClient
} from './embedUtilityClient'

type CacheEntry = {
  /** Null when SQLite lives only in utilityProcess (avoid main/utility lock races). */
  store: CodeIndexStore | null
  embedder: Embedder
  workspaceRoot: string
  /** SQLite modelId; may differ from embedder.modelId when hash fallback preserves a neural index. */
  indexModelId: string
}

type ResolvedEmbedder = {
  embedder: Embedder
  usedFallback: boolean
}

const cache = new Map<string, CacheEntry>()

export type CodeIndexOptions = {
  /**
   * Embedder selection. When omitted, uses `codeIndex.embedder` from settings
   * (default mdenseon). Legacy `preferOllama: true` maps to trying ollama only
   * when embedder is unset and forceOllama is set.
   */
  embedderId?: CodeIndexEmbedderId
  /** @deprecated Prefer embedderId / settings.codeIndex.embedder */
  preferOllama?: boolean
  embedder?: Embedder
  dimensions?: number
  /** Optional Ollama client overrides (tests / custom host). */
  ollama?: OllamaEmbedOptions
  /** Skip auto-download of ONNX weights. */
  autoDownload?: boolean
  /** Test inject for mDenseOn ensure. */
  mdenseon?: MDenseOnEnsureOptions
}

function readCodeIndexSettings(): {
  enabled: boolean
  embedder: CodeIndexEmbedderId
  autoDownload: boolean
  ollamaModel: string
  ollamaBaseUrl: string
} {
  const inVitest = process.env.VITEST === 'true' || process.env.VITEST === '1'
  try {
    const { getSettings } = require('@main/settings/settings') as typeof import('@main/settings/settings')
    const s = getSettings()
    const ci = s.codeIndex
    return {
      enabled: ci?.enabled !== false,
      embedder: ci?.embedder ?? 'mdenseon',
      // Unit tests must not hit Hugging Face.
      autoDownload: inVitest ? false : ci?.autoDownload !== false,
      ollamaModel: ci?.ollamaModel?.trim() || 'nomic-embed-text',
      ollamaBaseUrl: s.ollamaBaseUrl || 'http://127.0.0.1:11434'
    }
  } catch {
    return {
      enabled: true,
      embedder: 'mdenseon',
      autoDownload: inVitest ? false : true,
      ollamaModel: 'nomic-embed-text',
      ollamaBaseUrl: 'http://127.0.0.1:11434'
    }
  }
}

async function resolveEmbedder(
  opts: CodeIndexOptions & { signal?: AbortSignal } = {}
): Promise<ResolvedEmbedder> {
  if (opts.embedder) return { embedder: opts.embedder, usedFallback: false }

  const settings = readCodeIndexSettings()
  let embedderId: CodeIndexEmbedderId =
    opts.embedderId ??
    (opts.preferOllama === true ? 'ollama' : settings.embedder)

  // Legacy: preferOllama:false with no explicit id → hash (offline tests).
  if (opts.embedderId == null && opts.preferOllama === false) {
    embedderId = 'hash'
  }

  markCodeIndexEmbedder(embedderId)

  if (embedderId === 'hash') {
    setCodeIndexRuntimeStatus({
      phase: 'fallback_hash',
      embedder: 'hash',
      modelId: DEFAULT_MODEL_ID,
      message: 'Using local-hash embedder',
      error: null
    })
    return {
      embedder: createLocalHashEmbedder(opts.dimensions ?? DEFAULT_EMBED_DIM),
      usedFallback: false
    }
  }

  if (embedderId === 'ollama') {
    if (isEmbedderFailCached('ollama')) {
      setCodeIndexRuntimeStatus({
        phase: 'fallback_hash',
        embedder: 'hash',
        modelId: DEFAULT_MODEL_ID,
        message: 'Ollama unreachable — using hash',
        error: null
      })
      return {
        embedder: createLocalHashEmbedder(opts.dimensions ?? DEFAULT_EMBED_DIM),
        usedFallback: true
      }
    }
    try {
      const ollama = createOllamaEmbedder({
        ...opts.ollama,
        model: opts.ollama?.model ?? settings.ollamaModel,
        baseUrl: opts.ollama?.baseUrl ?? settings.ollamaBaseUrl
      })
      await ollama.embed(['probe'])
      clearEmbedderFailCache('ollama')
      setCodeIndexRuntimeStatus({
        phase: 'ready',
        embedder: 'ollama',
        modelId: ollama.modelId,
        message: 'Ollama embeddings ready',
        error: null
      })
      return { embedder: ollama, usedFallback: false }
    } catch (err) {
      if (!isAbortError(err) && !opts.signal?.aborted) {
        rememberEmbedderFail('ollama')
      }
      setCodeIndexRuntimeStatus({
        phase: 'fallback_hash',
        embedder: 'hash',
        modelId: DEFAULT_MODEL_ID,
        message: 'Ollama unreachable — using hash',
        error: null
      })
      return {
        embedder: createLocalHashEmbedder(opts.dimensions ?? DEFAULT_EMBED_DIM),
        usedFallback: true
      }
    }
  }

  // mdenseon (default) — settings/Vitest autoDownload wins over opts.mdenseon override
  if (isEmbedderFailCached('mdenseon')) {
    setCodeIndexRuntimeStatus({
      phase: 'fallback_hash',
      embedder: 'hash',
      modelId: DEFAULT_MODEL_ID,
      message: 'LightOn dense ONNX unavailable — using hash',
      error: null
    })
    return {
      embedder: createLocalHashEmbedder(opts.dimensions ?? DEFAULT_EMBED_DIM),
      usedFallback: true
    }
  }
  const autoDownload = opts.autoDownload ?? settings.autoDownload
  const canInjectSession =
    opts.mdenseon?.createSession != null
  if (!canInjectSession && !autoDownload && !mDenseOnWeightsOnDisk()) {
    setCodeIndexRuntimeStatus({
      phase: 'fallback_hash',
      embedder: 'hash',
      modelId: DEFAULT_MODEL_ID,
      message: 'LightOn dense ONNX unavailable — using hash',
      error: null
    })
    return {
      embedder: createLocalHashEmbedder(opts.dimensions ?? DEFAULT_EMBED_DIM),
      usedFallback: true
    }
  }
  setCodeIndexRuntimeStatus({
    phase: 'ready',
    embedder: 'mdenseon',
    modelId: MDENSEON_MODEL_ID,
    message: 'Ready',
    error: null
  })
  return {
    embedder: createMDenseOnEmbedder({
      ...opts.mdenseon,
      autoDownload,
      signal: opts.mdenseon?.signal ?? opts.signal
    }),
    usedFallback: false
  }
}

/** @internal */
export function resolveEmbedderForTests(
  opts: CodeIndexOptions & { signal?: AbortSignal } = {}
): Promise<ResolvedEmbedder> {
  return resolveEmbedder(opts)
}

export function workspaceKey(workspaceRoot: string): string {
  return process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot
}

function cacheKey(workspaceRoot: string, modelId: string): string {
  return `${workspaceKey(workspaceRoot)}::${modelId}`
}

const locks = new Map<string, Promise<void>>()

async function withWorkspaceLock<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = workspaceKey(workspaceRoot)
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  locks.set(key, prev.then(() => gate))
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

export async function getOrOpenCodeIndex(
  workspaceRoot: string,
  opts: CodeIndexOptions & { signal?: AbortSignal } = {}
): Promise<CacheEntry & { store: CodeIndexStore }> {
  const { embedder } = await resolveEmbedder(opts)
  const key = cacheKey(workspaceRoot, embedder.modelId)
  const existing = cache.get(key)
  if (existing?.store) {
    return existing as CacheEntry & { store: CodeIndexStore }
  }
  const wk = workspaceKey(workspaceRoot)
  for (const [k, v] of cache) {
    if (k.startsWith(`${wk}::`)) {
      v.store?.close()
      cache.delete(k)
    }
  }
  const store = CodeIndexStore.open(workspaceRoot, embedder.dimensions)
  const entry: CacheEntry & { store: CodeIndexStore } = {
    store,
    embedder,
    workspaceRoot,
    indexModelId: store.getMeta('modelId') ?? embedder.modelId
  }
  cache.set(key, entry)
  return entry
}

export function closeCodeIndex(workspaceRoot?: string): void {
  const prefix = workspaceRoot == null ? null : `${workspaceKey(workspaceRoot)}::`
  for (const [k, v] of cache) {
    if (prefix == null || k.startsWith(prefix)) {
      v.store?.close()
      cache.delete(k)
    }
  }
}

function embedderKindFor(embedder: Embedder): 'session' | 'hash' | 'ollama' {
  if (isHashEmbedderModelId(embedder.modelId)) {
    return 'hash'
  }
  if (embedder.modelId.startsWith('ollama:')) return 'ollama'
  return 'session'
}

function ollamaOptsForUtility(
  embedder: Embedder,
  ollama?: OllamaEmbedOptions
): { baseUrl: string; model: string; dimensions: number } | undefined {
  if (embedderKindFor(embedder) !== 'ollama') return undefined
  const settings = readCodeIndexSettings()
  const modelFromId = embedder.modelId.startsWith('ollama:')
    ? embedder.modelId.slice('ollama:'.length)
    : settings.ollamaModel
  return {
    baseUrl: ollama?.baseUrl ?? settings.ollamaBaseUrl,
    model: ollama?.model ?? modelFromId,
    dimensions: ollama?.dimensions ?? embedder.dimensions
  }
}

/** @internal */
export function buildOllamaUtilityOptsForTests(
  embedder: Embedder,
  ollama?: OllamaEmbedOptions
): { baseUrl: string; model: string; dimensions: number } | undefined {
  return ollamaOptsForUtility(embedder, ollama)
}

async function runCodeIndexSync(
  workspaceRoot: string,
  embedder: Embedder,
  signal?: AbortSignal,
  ollama?: OllamaEmbedOptions,
  files?: WalkedFile[],
  preserveNeural?: boolean
): Promise<SyncResult> {
  if (canUseIndexSyncUtility()) {
    closeCodeIndex(workspaceRoot)
    const client = getEmbedUtilityClient()
    const kind = embedderKindFor(embedder)
    return await client.syncCode({
      workspaceRoot,
      dbPath: codeindexDbPath(workspaceRoot),
      dimensions: embedder.dimensions,
      modelId: embedder.modelId,
      embedderKind: kind,
      ollama: ollamaOptsForUtility(embedder, ollama),
      files,
      preserveNeural,
      signal
    })
  }
  const entry = await getOrOpenCodeIndex(workspaceRoot, { embedder, signal })
  if (!entry.store) throw new Error('Code index store unavailable')
  return syncCodeIndex(workspaceRoot, entry.store, entry.embedder, {
    signal,
    files,
    preserveNeural
  })
}

async function runCodeIndexSearch(
  workspaceRoot: string,
  entry: CacheEntry,
  query: string,
  opts: {
    limit?: number
    mode?: CodebaseSearchMode
    signal?: AbortSignal
    ollama?: OllamaEmbedOptions
  }
): Promise<{ hits: CodebaseSearchHit[]; status: IndexStatus }> {
  if (canUseIndexSearchUtility()) {
    closeCodeIndex(workspaceRoot)
    const kind = embedderKindFor(entry.embedder)
    return await getEmbedUtilityClient().searchCode({
      workspaceRoot,
      dbPath: codeindexDbPath(workspaceRoot),
      dimensions: entry.embedder.dimensions,
      modelId: entry.embedder.modelId,
      embedderKind: kind,
      query,
      limit: opts.limit,
      mode: opts.mode,
      ollama: ollamaOptsForUtility(entry.embedder, opts.ollama),
      signal: opts.signal
    })
  }
  const store =
    entry.store ??
    (await getOrOpenCodeIndex(workspaceRoot, { embedder: entry.embedder, signal: opts.signal }))
      .store
  if (!store) throw new Error('Code index store unavailable')
  const hits = await searchCodeIndex(workspaceRoot, store, entry.embedder, query, {
    limit: opts.limit,
    mode: opts.mode,
    signal: opts.signal
  })
  return { hits, status: store.getStatus() }
}

function makeCacheEntry(
  workspaceRoot: string,
  embedder: Embedder,
  store: CodeIndexStore | null,
  indexModelId: string
): CacheEntry {
  return { store, embedder, workspaceRoot, indexModelId }
}

async function ensureCodeIndexSyncedUnlocked(
  workspaceRoot: string,
  opts: CodeIndexOptions & {
    signal?: AbortSignal
    force?: boolean
    files?: WalkedFile[]
    keepIndexingStatus?: boolean
  } = {}
): Promise<{ entry: CacheEntry | null; sync: SyncResult | null; disabled?: boolean }> {
  const settings = readCodeIndexSettings()
  if (!settings.enabled && opts.embedder == null && opts.embedderId == null && opts.preferOllama == null) {
    setCodeIndexRuntimeStatus({
      phase: 'idle',
      message: 'Codebase index disabled',
      error: null,
      indexProgress: null,
      progress: null
    })
    return { entry: null, sync: null, disabled: true }
  }
  const { embedder, usedFallback } = await resolveEmbedder(opts)
  const useUtility = canUseIndexSyncUtility()

  setCodeIndexRuntimeStatus({
    phase: 'indexing',
    message: opts.force ? 'Syncing codebase index' : 'Incremental sync',
    error: null,
    indexProgress: null
  })

  const sync = await runCodeIndexSync(
    workspaceRoot,
    embedder,
    opts.signal,
    opts.ollama,
    opts.files,
    usedFallback
  )
  const indexModelId = sync.status.modelId || embedder.modelId
  const keptNeural =
    usedFallback && Boolean(indexModelId) && !isHashEmbedderModelId(indexModelId)
  if (keptNeural) {
    logger.warn('Keeping existing neural code index; embedder fell back to hash', {
      scope: 'codeindex',
      storeModelId: indexModelId,
      queryModelId: embedder.modelId
    })
  }
  // Keep the DB off main when utilityProcess handles sync/search.
  const entry = useUtility
    ? makeCacheEntry(workspaceRoot, embedder, null, indexModelId)
    : await getOrOpenCodeIndex(workspaceRoot, { ...opts, embedder })
  entry.indexModelId = indexModelId
  if (useUtility) closeCodeIndex(workspaceRoot)
  if (opts.keepIndexingStatus) {
    setCodeIndexRuntimeStatus({
      phase: keptNeural || isHashEmbedderModelId(entry.embedder.modelId) ? 'fallback_hash' : 'indexing',
      modelId: entry.indexModelId,
      message: keptNeural
        ? `Neural embedder unavailable — kept existing index — sparse next…`
        : sync
          ? `Code index synced · ${sync.indexed} updated · ${sync.skipped} skipped — sparse next…`
          : 'Code index synced — sparse next…',
      error: null,
      progress: sync && sync.scanned > 0 ? Math.min(0.7, sync.scanned > 0 ? 0.7 : 0) : 0.7,
      indexProgress: sync
        ? {
            kind: 'code',
            stage: 'done',
            filesDone: sync.scanned,
            filesTotal: sync.scanned,
            indexed: sync.indexed,
            skipped: sync.skipped,
            removed: sync.removed,
            embedChunks: 0,
            currentPath: null
          }
        : null
    })
  } else {
    clearIndexSyncProgress()
    setCodeIndexRuntimeStatus({
      phase: keptNeural || isHashEmbedderModelId(entry.embedder.modelId) ? 'fallback_hash' : 'ready',
      modelId: entry.indexModelId,
      message: keptNeural
        ? `Neural embedder unavailable — kept ${indexModelId} (lexical search)`
        : sync
          ? `Index ready · ${sync.indexed} updated · ${sync.skipped} skipped`
          : 'Index ready',
      error: null,
      progress: 1,
      indexProgress: sync
        ? {
            kind: 'code',
            stage: 'done',
            filesDone: sync.scanned,
            filesTotal: sync.scanned,
            indexed: sync.indexed,
            skipped: sync.skipped,
            removed: sync.removed,
            embedChunks: 0,
            currentPath: null
          }
        : null
    })
  }
  return { entry, sync }
}

export async function ensureCodeIndexSynced(
  workspaceRoot: string,
  opts: CodeIndexOptions & {
    signal?: AbortSignal
    force?: boolean
    files?: WalkedFile[]
    keepIndexingStatus?: boolean
  } = {}
): Promise<{ entry: CacheEntry | null; sync: SyncResult | null; disabled?: boolean }> {
  return withWorkspaceLock(workspaceRoot, () => ensureCodeIndexSyncedUnlocked(workspaceRoot, opts))
}

function schedulePostSearchWarm(workspaceRoot: string): void {
  // Full code+sparse warm after this interactive job releases the queue.
  // Dynamic import avoids a load-time cycle (workspaceIndex imports this module).
  void import('../workspaceIndex')
    .then((m) => {
      m.warmWorkspaceIndexes(workspaceRoot)
    })
    .catch(() => undefined)
}

export async function runCodebaseSearch(
  workspaceRoot: string,
  query: string,
  opts: {
    limit?: number
    mode?: CodebaseSearchMode
    signal?: AbortSignal
    preferOllama?: boolean
    embedderId?: CodeIndexEmbedderId
    refresh?: boolean
  } = {}
): Promise<{
  hits: CodebaseSearchHit[]
  status: IndexStatus
  formatted: string
  queryModelId: string
}> {
  const ws = await import('../workspaceIndex')
  const searchSignal = ws.workspaceIndexSearchSignal(workspaceRoot, opts.signal)
  let skipWarm = false
  const result = await enqueueIndexJob({
    priority: 'interactive',
    signal: searchSignal,
    run: () =>
      withWorkspaceLock(workspaceRoot, async () => {
        const disabledResult = {
          hits: [] as CodebaseSearchHit[],
          status: {
            ready: false,
            modelId: '',
            fileCount: 0,
            chunkCount: 0,
            lastIndexedAt: null
          },
          formatted: 'Codebase index is disabled (Settings → Indexing).',
          queryModelId: ''
        }
        // refresh=true forces a sync in this slot. Otherwise serve whatever is
        // already indexed and enqueue a warm sync after we release the queue —
        // a cold full sync inside interactive would starve every later search.
        if (opts.refresh === true) {
          const { entry, disabled } = await ensureCodeIndexSyncedUnlocked(workspaceRoot, {
            signal: searchSignal,
            preferOllama: opts.preferOllama,
            embedderId: opts.embedderId,
            force: true
          })
          if (disabled || !entry) {
            skipWarm = true
            return disabledResult
          }
          const { hits, status } = await runCodeIndexSearch(workspaceRoot, entry, query, {
            limit: opts.limit,
            mode: opts.mode,
            signal: searchSignal
          })
          return {
            hits,
            status,
            formatted: formatSearchHits(hits),
            queryModelId: entry.embedder.modelId
          }
        }

        const settings = readCodeIndexSettings()
        if (!settings.enabled && opts.preferOllama == null && opts.embedderId == null) {
          skipWarm = true
          return disabledResult
        }

        const { embedder } = await resolveEmbedder({
          preferOllama: opts.preferOllama,
          embedderId: opts.embedderId
        })
        const useUtility = canUseIndexSyncUtility()
        const entry = useUtility
          ? makeCacheEntry(workspaceRoot, embedder, null, embedder.modelId)
          : await getOrOpenCodeIndex(workspaceRoot, {
              embedder,
              signal: searchSignal,
              preferOllama: opts.preferOllama,
              embedderId: opts.embedderId
            })
        if (useUtility) closeCodeIndex(workspaceRoot)

        const { hits, status } = await runCodeIndexSearch(workspaceRoot, entry, query, {
          limit: opts.limit,
          mode: opts.mode,
          signal: searchSignal
        })
        if (!status.ready && status.chunkCount === 0) {
          const { sync, entry: syncedEntry } = await ensureCodeIndexSyncedUnlocked(workspaceRoot, {
            signal: searchSignal,
            preferOllama: opts.preferOllama,
            embedderId: opts.embedderId,
            force: true
          })
          if (sync) {
            const searchEntry = syncedEntry ?? entry
            const retried = await runCodeIndexSearch(workspaceRoot, searchEntry, query, {
              limit: opts.limit,
              mode: opts.mode,
              signal: searchSignal
            })
            return {
              hits: retried.hits,
              status: retried.status,
              formatted: formatSearchHits(retried.hits),
              queryModelId: searchEntry.embedder.modelId
            }
          }
        }

        const formatted =
          hits.length > 0
            ? formatSearchHits(hits)
            : status.ready
              ? formatSearchHits(hits)
              : [
                  formatSearchHits(hits),
                  'Codebase index is still warming — results may be incomplete. Retry shortly or pass refresh:true.'
                ]
                  .filter(Boolean)
                  .join('\n')
        return { hits, status, formatted, queryModelId: entry.embedder.modelId }
      })
  })
  if (!skipWarm) {
    schedulePostSearchWarm(workspaceRoot)
  }
  return result
}

export function disposeCodeIndexWorkspace(workspaceRoot: string): void {
  closeCodeIndex(workspaceRoot)
}

/** Force reindex for active settings (settings UI). */
export async function reindexCodeIndex(
  workspaceRoot: string,
  opts: { signal?: AbortSignal } = {}
): Promise<SyncResult | null> {
  const key = workspaceKey(workspaceRoot)
  return enqueueIndexJob({
    priority: 'reindex',
    coalesceKey: `reindex:${key}`,
    signal: opts.signal,
    run: async () => {
      clearEmbedderFailCache()
      const { sync } = await ensureCodeIndexSynced(workspaceRoot, {
        force: true,
        signal: opts.signal
      })
      // Dynamic import: codeindex barrel must not statically import sparsegrep
      // (tools → codeindex → sparsegrep → ... → electron window named exports break Vitest).
      const { ensureSparseGrepSynced, SPARSE_GREP_SCAN_CAP } = await import('../sparsegrep')
      await ensureSparseGrepSynced(workspaceRoot, {
        force: true,
        signal: opts.signal,
        pageCap: SPARSE_GREP_SCAN_CAP
      })
      return sync
    }
  })
}
