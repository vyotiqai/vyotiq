import { existsSync } from 'fs'
import { SparseGrepStore, sparsegrepRoot, sparsegrepDbPath } from './store'
import { syncSparseGrep, type SparseSyncResult } from './sync'
import {
  lookupCandidatesForRegex,
  lookupCandidatesForSubstring,
  type CandidateLookup
} from './query'
import type { WalkedFile } from '../tools/walk'
import { isAbortError } from '../../../shared/errors'
import {
  canUseIndexSearchUtility,
  canUseIndexSyncUtility,
  getEmbedUtilityClient
} from '../codeindex/embedUtilityClient'

export { SparseGrepStore, sparsegrepRoot, sparsegrepDbPath } from './store'
export { syncSparseGrep, SPARSE_GREP_SCAN_CAP, RECONCILE_WALK_CAP } from './sync'
export {
  extractTrigrams,
  requiredTrigramsForPattern,
  requiredTrigramsForSubstring
} from './trigram'
export {
  lookupCandidatesForRegex,
  lookupCandidatesForSubstring,
  resolveCandidateFullPaths
} from './query'

/** Debounce window (ms). */
export const SPARSE_GREP_SYNC_DEBOUNCE_MS = 1500

type CacheEntry = { store: SparseGrepStore; workspaceRoot: string }

const cache = new Map<string, CacheEntry>()
/** Serialize sync/open per workspace so yieldToEventLoop cannot interleave writers. */
const locks = new Map<string, Promise<void>>()

export function workspaceKey(workspaceRoot: string): string {
  return process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot
}

function cacheKey(workspaceRoot: string): string {
  return workspaceKey(workspaceRoot)
}

async function withWorkspaceLock<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = workspaceKey(workspaceRoot)
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const chained = prev.then(() => gate)
  locks.set(key, chained)
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

export function getOrOpenSparseGrep(workspaceRoot: string): SparseGrepStore {
  const key = cacheKey(workspaceRoot)
  const existing = cache.get(key)
  if (existing) return existing.store
  const store = SparseGrepStore.open(workspaceRoot)
  cache.set(key, { store, workspaceRoot })
  return store
}

export function closeSparseGrep(workspaceRoot?: string): void {
  if (workspaceRoot == null) {
    for (const [, v] of cache) v.store.close()
    cache.clear()
    return
  }
  const key = cacheKey(workspaceRoot)
  const entry = cache.get(key)
  if (entry) {
    entry.store.close()
    cache.delete(key)
  }
}

async function runSparseGrepSync(
  workspaceRoot: string,
  opts: { signal?: AbortSignal; files?: WalkedFile[]; pageCap?: number }
): Promise<SparseSyncResult> {
  if (canUseIndexSyncUtility()) {
    closeSparseGrep(workspaceRoot)
    return await getEmbedUtilityClient().syncSparse({
      workspaceRoot,
      dbPath: sparsegrepDbPath(workspaceRoot),
      files: opts.files,
      pageCap: opts.pageCap,
      signal: opts.signal
    })
  }
  const store = getOrOpenSparseGrep(workspaceRoot)
  return syncSparseGrep(workspaceRoot, store, {
    signal: opts.signal,
    files: opts.files,
    pageCap: opts.pageCap
  })
}

export async function ensureSparseGrepSynced(
  workspaceRoot: string,
  opts: { signal?: AbortSignal; force?: boolean; files?: WalkedFile[]; pageCap?: number } = {}
): Promise<{ store: SparseGrepStore | null; sync: SparseSyncResult | null }> {
  return withWorkspaceLock(workspaceRoot, async () => {
    // Utility owns SQLite — never open/cache on main (Windows database-is-locked races).
    if (canUseIndexSyncUtility()) {
      const sync = await runSparseGrepSync(workspaceRoot, {
        signal: opts.signal,
        files: opts.files,
        pageCap: opts.pageCap
      })
      closeSparseGrep(workspaceRoot)
      return { store: null, sync }
    }
    if (!opts.force && opts.files == null) {
      try {
        const peek = getOrOpenSparseGrep(workspaceRoot)
        if (peek.getStatus().ready) {
          const sync = await runSparseGrepSync(workspaceRoot, {
            signal: opts.signal,
            pageCap: opts.pageCap
          })
          const store = getOrOpenSparseGrep(workspaceRoot)
          return { store, sync }
        }
      } catch {
        /* fall through to full sync */
      }
    }
    const sync = await runSparseGrepSync(workspaceRoot, {
      signal: opts.signal,
      files: opts.files,
      pageCap: opts.pageCap
    })
    const store = getOrOpenSparseGrep(workspaceRoot)
    return { store, sync }
  })
}

export function disposeSparseGrepWorkspace(workspaceRoot: string): void {
  closeSparseGrep(workspaceRoot)
}

/** Ready store for query, or null if cold / missing. Does not create a DB. */
export function tryGetReadySparseGrep(workspaceRoot: string): SparseGrepStore | null {
  try {
    if (!existsSync(sparsegrepDbPath(workspaceRoot))) return null
    const store = getOrOpenSparseGrep(workspaceRoot)
    if (!store.getStatus().ready) return null
    return store
  } catch {
    return null
  }
}

export type SparseCandidateQueryResult = {
  lookup: CandidateLookup
  fileCount: number
  syncComplete: boolean
}

/**
 * Trigram candidate lookup; uses utilityProcess when available.
 * On utility failure returns null so callers can fall back to a live walk.
 */
export async function querySparseCandidates(
  workspaceRoot: string,
  opts: {
    query: string
    kind: 'regex' | 'substring'
    caseSensitive?: boolean
    signal?: AbortSignal
  }
): Promise<SparseCandidateQueryResult | null> {
  if (!existsSync(sparsegrepDbPath(workspaceRoot))) return null

  if (canUseIndexSearchUtility()) {
    try {
      closeSparseGrep(workspaceRoot)
      const sparse = await getEmbedUtilityClient().sparseLookup({
        dbPath: sparsegrepDbPath(workspaceRoot),
        query: opts.query,
        kind: opts.kind,
        caseSensitive: opts.caseSensitive,
        signal: opts.signal
      })
      return {
        lookup: sparse.lookup,
        fileCount: sparse.fileCount,
        syncComplete: sparse.syncComplete
      }
    } catch (err) {
      if (isAbortError(err) || opts.signal?.aborted) throw err
      return null
    }
  }

  const store = tryGetReadySparseGrep(workspaceRoot)
  if (!store) return null
  const lookup =
    opts.kind === 'regex'
      ? lookupCandidatesForRegex(store, opts.query, opts.caseSensitive === true)
      : lookupCandidatesForSubstring(store, opts.query)
  return {
    lookup,
    fileCount: store.getStatus().fileCount,
    syncComplete: store.getMeta('syncComplete') === 'true'
  }
}

export type SparseFileListQueryResult = {
  ready: boolean
  paths: string[]
  fileCount: number
  syncComplete: boolean
}

/** Sparse file list for glob; uses utilityProcess when available. */
export async function querySparseFileList(
  workspaceRoot: string,
  opts: { signal?: AbortSignal } = {}
): Promise<SparseFileListQueryResult | null> {
  if (!existsSync(sparsegrepDbPath(workspaceRoot))) return null

  if (canUseIndexSearchUtility()) {
    try {
      closeSparseGrep(workspaceRoot)
      const sparse = await getEmbedUtilityClient().sparseListFiles({
        dbPath: sparsegrepDbPath(workspaceRoot),
        signal: opts.signal
      })
      return {
        ready: sparse.ready,
        paths: sparse.paths,
        fileCount: sparse.fileCount,
        syncComplete: sparse.syncComplete
      }
    } catch (err) {
      if (isAbortError(err) || opts.signal?.aborted) throw err
      return null
    }
  }

  const store = tryGetReadySparseGrep(workspaceRoot)
  if (!store) return null
  const status = store.getStatus()
  const syncComplete = store.getMeta('syncComplete') === 'true'
  return {
    ready: status.ready,
    paths: status.ready ? store.listFilePaths() : [],
    fileCount: status.fileCount,
    syncComplete
  }
}
