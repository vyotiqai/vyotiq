/**
 * Shared warm/debounce for codeindex + sparsegrep.
 * Indexes live under Electron userData/workspaces/{id}/ — not `.vyotiq/`.
 * Warm is serialized via the global index job queue (codeindex then sparsegrep).
 */
import { existsSync, rmSync } from 'fs'
import { ensureCodeIndexSynced, disposeCodeIndexWorkspace, isHashEmbedderModelId } from './codeindex'
import {
  ensureSparseGrepSynced,
  disposeSparseGrepWorkspace,
  SPARSE_GREP_SYNC_DEBOUNCE_MS,
  SPARSE_GREP_SCAN_CAP
} from './sparsegrep'
import { throwIfAborted } from './tools/walk'
import { legacyCodeindexRoot, legacySparsegrepRoot } from './indexStoragePaths'
import { isAbortError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { logErrorSummary } from '../../shared/utils/logPolicy'
import {
  activeIndexJobPreemptSignal,
  dropPendingByCoalesceKey,
  enqueueIndexJob,
  IndexQueueFullError
} from './indexJobQueue'
import { clearIndexSyncProgress } from './codeindex/indexProgress'
import { setCodeIndexRuntimeStatus } from './codeindex/modelStatus'

export const WORKSPACE_INDEX_DEBOUNCE_MS = SPARSE_GREP_SYNC_DEBOUNCE_MS

function workspaceKey(workspaceRoot: string): string {
  return process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const abortControllers = new Map<string, AbortController>()
/** Worktrees torn down permanently — block warm/search after instance finalize. */
const permanentlyDisposedKeys = new Set<string>()

function controllerFor(workspaceRoot: string): AbortController {
  const key = workspaceKey(workspaceRoot)
  let c = abortControllers.get(key)
  if (!c || c.signal.aborted) {
    c = new AbortController()
    abortControllers.set(key, c)
  }
  return c
}

export function workspaceIndexAbortSignal(workspaceRoot: string): AbortSignal {
  const key = workspaceKey(workspaceRoot)
  if (permanentlyDisposedKeys.has(key)) {
    const ac = new AbortController()
    ac.abort()
    return ac.signal
  }
  return controllerFor(workspaceRoot).signal
}

/** Combine workspace dispose with caller abort (codebase_search interactive jobs). */
export function workspaceIndexSearchSignal(
  workspaceRoot: string,
  callerSignal?: AbortSignal
): AbortSignal {
  return combineSignals(workspaceIndexAbortSignal(workspaceRoot), callerSignal)
}

function combineSignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => s != null)
  if (list.length === 0) {
    return new AbortController().signal
  }
  if (list.length === 1) return list[0]!
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list)
  }
  const ac = new AbortController()
  const onAbort = (): void => ac.abort()
  for (const s of list) {
    if (s.aborted) {
      ac.abort()
      return ac.signal
    }
    s.addEventListener('abort', onAbort, { once: true })
  }
  return ac.signal
}

/** Drop pre-migration SQLite caches that lived inside the project tree. */
export function removeLegacyWorkspaceIndexDirs(workspaceRoot: string): void {
  for (const root of [legacyCodeindexRoot(workspaceRoot), legacySparsegrepRoot(workspaceRoot)]) {
    if (!existsSync(root)) continue
    try {
      rmSync(root, { recursive: true, force: true })
      logger.info('Removed legacy in-workspace index dir', { scope: 'workspaceIndex', root })
    } catch (err) {
      logger.warn('Failed to remove legacy index dir', { scope: 'workspaceIndex', root, err })
    }
  }
}

/** Warm both indexes (boot / workspace open) via a single background job. */
export function warmWorkspaceIndexes(workspaceRoot: string): void {
  if (!workspaceRoot.trim()) return
  const key = workspaceKey(workspaceRoot)
  if (permanentlyDisposedKeys.has(key)) return
  removeLegacyWorkspaceIndexDirs(workspaceRoot)
  const coalesceKey = `warm:${key}`

  void enqueueIndexJob({
    priority: 'warm',
    coalesceKey,
    run: async () => {
      // Resolve dispose signal inside run so coalesce+dispose+reopen does not pin a stale abort.
      const disposeSignal = controllerFor(workspaceRoot).signal
      const signal = combineSignals(disposeSignal, activeIndexJobPreemptSignal())
      try {
        throwIfAborted(signal)
        logger.info('Workspace index warm started', { scope: 'workspaceIndex' })
        throwIfAborted(signal)
        const code = await ensureCodeIndexSynced(workspaceRoot, {
          signal,
          keepIndexingStatus: true
        })
        if (code.sync) {
          logger.info('Code index warm sync', {
            scope: 'workspaceIndex',
            workspace: workspaceRoot,
            scanned: code.sync.scanned,
            indexed: code.sync.indexed,
            skipped: code.sync.skipped,
            removed: code.sync.removed,
            complete: code.sync.syncComplete,
            model: code.entry?.embedder.modelId
          })
        }
        throwIfAborted(signal)
        const sparse = await ensureSparseGrepSynced(workspaceRoot, {
          signal,
          pageCap: SPARSE_GREP_SCAN_CAP
        })
        if (sparse.sync) {
          logger.info('Sparse grep warm sync', {
            scope: 'workspaceIndex',
            workspace: workspaceRoot,
            scanned: sparse.sync.scanned,
            indexed: sparse.sync.indexed,
            skipped: sparse.sync.skipped,
            removed: sparse.sync.removed,
            complete: sparse.sync.syncComplete
          })
        }
        const codeDone = code.disabled === true || code.sync == null || code.sync.syncComplete
        const sparseDone = sparse.sync == null || sparse.sync.syncComplete
        if (!codeDone || !sparseDone) {
          setCodeIndexRuntimeStatus({
            phase: 'indexing',
            modelId: code.entry?.indexModelId ?? code.entry?.embedder.modelId ?? '',
            message: 'Indexes paging — continuing in background',
            error: null,
            progress: 0.7,
            indexProgress: null
          })
          warmWorkspaceIndexes(workspaceRoot)
          return
        }
        clearIndexSyncProgress()
        const queryModelId = code.entry?.embedder.modelId ?? ''
        const indexModelId = code.entry?.indexModelId ?? queryModelId
        const queryHash = Boolean(queryModelId) && isHashEmbedderModelId(queryModelId)
        const keptNeural =
          queryHash && Boolean(indexModelId) && !isHashEmbedderModelId(indexModelId)
        setCodeIndexRuntimeStatus({
          phase: queryHash
            ? 'fallback_hash'
            : code.disabled
              ? 'idle'
              : 'ready',
          modelId: indexModelId,
          message: keptNeural
            ? `Neural embedder unavailable — kept ${indexModelId} (lexical search)`
            : code.sync && sparse.sync
              ? `Indexes ready · code ${code.sync.indexed} upd/${code.sync.skipped} skip · sparse ${sparse.sync.indexed} upd/${sparse.sync.skipped} skip`
              : 'Indexes ready',
          error: null,
          progress: 1,
          indexProgress: null
        })
      } catch (err) {
        if (signal.aborted || isAbortError(err)) return
        throw err
      }
    }
  }).catch((err: unknown) => {
    const disposeSignal = abortControllers.get(key)?.signal
    if (disposeSignal?.aborted || isAbortError(err)) return
    if (err instanceof IndexQueueFullError) return
    logger.warn('Workspace index warm failed', {
      scope: 'workspaceIndex',
      reason: logErrorSummary(err)
    })
  })
}

/** Debounced sync after mutations — one timer warms both indexes. */
export function scheduleWorkspaceIndexSync(
  workspaceRoot: string,
  delayMs: number = WORKSPACE_INDEX_DEBOUNCE_MS
): void {
  if (!workspaceRoot.trim()) return
  // Instance worktrees index on first codebase_search, not on every mutation.
  if (workspaceRoot.replace(/\\/g, '/').split('/').includes('instance-worktrees')) return
  const key = workspaceKey(workspaceRoot)
  const prev = timers.get(key)
  if (prev) clearTimeout(prev)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      warmWorkspaceIndexes(workspaceRoot)
    }, delayMs)
  )
}

export type DisposeWorkspaceIndexesOptions = {
  /** Instance worktree finalize — never warm or search this root again. */
  permanent?: boolean
}

export function disposeWorkspaceIndexes(
  workspaceRoot: string,
  opts: DisposeWorkspaceIndexesOptions = {}
): void {
  const key = workspaceKey(workspaceRoot)
  if (opts.permanent === true) {
    permanentlyDisposedKeys.add(key)
  }
  const prev = timers.get(key)
  if (prev) clearTimeout(prev)
  timers.delete(key)
  dropPendingByCoalesceKey(`warm:${key}`)
  dropPendingByCoalesceKey(`reindex:${key}`)
  const ac = abortControllers.get(key)
  if (ac) {
    ac.abort()
    abortControllers.delete(key)
  }
  disposeCodeIndexWorkspace(workspaceRoot)
  disposeSparseGrepWorkspace(workspaceRoot)
}

/** Test helper. */
export function clearWorkspaceIndexSyncTimers(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  for (const ac of abortControllers.values()) ac.abort()
  abortControllers.clear()
  permanentlyDisposedKeys.clear()
}
