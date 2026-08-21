import { readFileSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { SparseGrepStore } from './store'
import { extractTrigrams } from './trigram'
import {
  CODE_INDEX_EXTS,
  collectWorkspaceFiles,
  collectWorkspaceFilesPage,
  INDEX_SKIP_DIR_SEGMENTS,
  isIndexableSourcePath,
  throwIfAborted,
  yieldToEventLoop,
  type WalkedFile
} from '../tools/walk'
import {
  publishIndexSyncProgress,
  type IndexProgressUpdate
} from '../codeindex/indexProgress'

const YIELD_EVERY = 32
/** Page size for the source-only trigram index. */
export const SPARSE_GREP_SCAN_CAP = 20_000
export const RECONCILE_WALK_CAP = SPARSE_GREP_SCAN_CAP * 2
/** Same 512KB cap as grep/codeindex — oversized files stay out of the trigram index. */
const MAX_FILE_BYTES = 512 * 1024
const PROGRESS_THROTTLE_MS = 75

function isMissingPathError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err != null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  )
}

export type SparseSyncResult = {
  scanned: number
  indexed: number
  skipped: number
  removed: number
  partial: boolean
  syncComplete: boolean
  cursor: string | null
}

export type SyncSparseGrepOptions = {
  signal?: AbortSignal
  files?: WalkedFile[]
  onProgress?: (update: IndexProgressUpdate, opts?: { force?: boolean }) => void
  /** Page size for paged walks. Tests pass a small cap; production walks unbounded unless pageCap is set. */
  pageCap?: number
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function report(
  onProgress: SyncSparseGrepOptions['onProgress'],
  update: IndexProgressUpdate,
  opts?: { force?: boolean }
): void {
  if (onProgress) {
    onProgress(update, opts)
    return
  }
  publishIndexSyncProgress(update, opts)
}

function createThrottledProgress(
  onProgress: SyncSparseGrepOptions['onProgress']
): SyncSparseGrepOptions['onProgress'] {
  if (!onProgress) return undefined
  let last = 0
  return (update, opts) => {
    const now = Date.now()
    if (!opts?.force && now - last < PROGRESS_THROTTLE_MS) return
    last = now
    onProgress(update, opts)
  }
}

async function indexWalkedFiles(
  files: WalkedFile[],
  store: SparseGrepStore,
  signal: AbortSignal | undefined,
  onProgress: SyncSparseGrepOptions['onProgress']
): Promise<{ indexed: number; skipped: number; seen: Set<string> }> {
  const seen = new Set<string>()
  let indexed = 0
  let skipped = 0
  const textFiles = files.filter((f) => isIndexableSourcePath(f.rel, f.full))
  const filesTotal = textFiles.length

  for (let i = 0; i < textFiles.length; i++) {
    throwIfAborted(signal)
    if (i > 0 && i % YIELD_EVERY === 0) {
      await yieldToEventLoop()
      throwIfAborted(signal)
    }
    const { full, rel } = textFiles[i]!
    let st
    try {
      st = statSync(full)
    } catch (err) {
      if (!isMissingPathError(err) && store.getFileHash(rel)) seen.add(rel)
      skipped++
      report(onProgress, {
        kind: 'sparse',
        stage: 'scanning',
        filesDone: i + 1,
        filesTotal,
        indexed,
        skipped,
        currentPath: rel
      })
      continue
    }
    if (!st.isFile()) {
      if (store.getFileHash(rel)) seen.add(rel)
      skipped++
      report(onProgress, {
        kind: 'sparse',
        stage: 'scanning',
        filesDone: i + 1,
        filesTotal,
        indexed,
        skipped,
        currentPath: rel
      })
      continue
    }
    if (st.size > MAX_FILE_BYTES) {
      skipped++
      report(onProgress, {
        kind: 'sparse',
        stage: 'scanning',
        filesDone: i + 1,
        filesTotal,
        indexed,
        skipped,
        currentPath: rel
      })
      continue
    }
    const mtimeMs = Math.round(st.mtimeMs)
    const stamp = store.getFileStamp(rel)
    if (stamp && stamp.mtimeMs === mtimeMs && stamp.size === st.size) {
      seen.add(rel)
      skipped++
      report(onProgress, {
        kind: 'sparse',
        stage: 'scanning',
        filesDone: i + 1,
        filesTotal,
        indexed,
        skipped,
        currentPath: rel
      })
      continue
    }
    let text: string
    try {
      text = readFileSync(full, 'utf8')
    } catch (err) {
      if (!isMissingPathError(err) && store.getFileHash(rel)) seen.add(rel)
      skipped++
      report(onProgress, {
        kind: 'sparse',
        stage: 'scanning',
        filesDone: i + 1,
        filesTotal,
        indexed,
        skipped,
        currentPath: rel
      })
      continue
    }
    if (text.includes('\0')) {
      skipped++
      report(onProgress, {
        kind: 'sparse',
        stage: 'scanning',
        filesDone: i + 1,
        filesTotal,
        indexed,
        skipped,
        currentPath: rel
      })
      continue
    }
    const fileHash = sha256Text(text)
    if (store.getFileHash(rel) === fileHash) {
      store.updateFileStamp(rel, fileHash, mtimeMs, st.size)
      seen.add(rel)
      skipped++
      report(onProgress, {
        kind: 'sparse',
        stage: 'scanning',
        filesDone: i + 1,
        filesTotal,
        indexed,
        skipped,
        currentPath: rel
      })
      continue
    }
    // Index lowercased trigrams so CI queries work; caseSensitive verify still exact.
    const grams = extractTrigrams(text, false)
    store.replaceFileTrigrams(rel, fileHash, grams, mtimeMs, st.size)
    seen.add(rel)
    indexed++
    report(onProgress, {
      kind: 'sparse',
      stage: 'scanning',
      filesDone: i + 1,
      filesTotal,
      indexed,
      skipped,
      currentPath: rel
    })
  }

  return { indexed, skipped, seen }
}

function reconcileStaleFiles(store: SparseGrepStore, seen: Set<string>): number {
  return store.deleteFilesNotIn(seen)
}

export async function syncSparseGrep(
  workspaceRoot: string,
  store: SparseGrepStore,
  signalOrOpts?: AbortSignal | SyncSparseGrepOptions,
  precollected?: WalkedFile[]
): Promise<SparseSyncResult> {
  const opts: SyncSparseGrepOptions =
    signalOrOpts != null && typeof signalOrOpts === 'object' && !('aborted' in signalOrOpts)
      ? signalOrOpts
      : { signal: signalOrOpts as AbortSignal | undefined, files: precollected }
  const signal = opts.signal
  const onProgress = createThrottledProgress(opts.onProgress)
  const filesOpt = opts.files ?? precollected

  throwIfAborted(signal)

  report(
    onProgress,
    {
      kind: 'sparse',
      stage: 'walking',
      filesDone: 0,
      filesTotal: 0,
      indexed: 0,
      skipped: 0,
      currentPath: null
    },
    { force: true }
  )

  if (filesOpt != null) {
    report(
      onProgress,
      {
        kind: 'sparse',
        stage: 'scanning',
        filesDone: 0,
        filesTotal: filesOpt.length,
        indexed: 0,
        skipped: 0,
        currentPath: null
      },
      { force: true }
    )
    const { indexed, skipped, seen } = await indexWalkedFiles(filesOpt, store, signal, onProgress)
    const scanCap = opts.pageCap
    const capped =
      scanCap != null && Number.isFinite(scanCap) && filesOpt.length >= scanCap
    if (!capped) {
      report(
        onProgress,
        {
          kind: 'sparse',
          stage: 'reconciling',
          filesDone: filesOpt.length,
          filesTotal: filesOpt.length,
          indexed,
          skipped,
          currentPath: null
        },
        { force: true }
      )
    }
    const removed = capped ? 0 : reconcileStaleFiles(store, seen)
    store.setMeta('syncComplete', capped ? 'false' : 'true')
    store.setMeta('syncCursor', '')
    store.setMeta('lastIndexedAt', new Date().toISOString())
    report(
      onProgress,
      {
        kind: 'sparse',
        stage: 'done',
        filesDone: filesOpt.length,
        filesTotal: filesOpt.length,
        indexed,
        skipped,
        removed,
        currentPath: null
      },
      { force: true }
    )
    return {
      scanned: filesOpt.length,
      indexed,
      skipped,
      removed,
      partial: capped,
      syncComplete: !capped,
      cursor: null
    }
  }

  const priorCursor = store.getMeta('syncCursor')
  let startAfter = priorCursor && priorCursor.length > 0 ? priorCursor : undefined
  const pageCap = opts.pageCap
  let page = await collectWorkspaceFilesPage(
    workspaceRoot,
    pageCap,
    startAfter,
    signal,
    CODE_INDEX_EXTS,
    INDEX_SKIP_DIR_SEGMENTS
  )
  if (startAfter && page.cursorMissing) {
    store.setMeta('syncCursor', '')
    startAfter = undefined
    page = await collectWorkspaceFilesPage(
      workspaceRoot,
      pageCap,
      undefined,
      signal,
      CODE_INDEX_EXTS,
      INDEX_SKIP_DIR_SEGMENTS
    )
  }
  throwIfAborted(signal)

  report(
    onProgress,
    {
      kind: 'sparse',
      stage: 'scanning',
      filesDone: 0,
      filesTotal: page.files.length,
      indexed: 0,
      skipped: 0,
      currentPath: null
    },
    { force: true }
  )

  const { indexed, skipped, seen: pageSeen } = await indexWalkedFiles(page.files, store, signal, onProgress)

  const batchComplete =
    page.exhausted || (pageCap != null && Number.isFinite(pageCap) && page.files.length < pageCap)
  let removed = 0
  let partial = !batchComplete
  let syncComplete = batchComplete
  let cursor: string | null = batchComplete ? null : page.lastRel

  if (batchComplete) {
    store.setMeta('syncComplete', 'true')
    store.setMeta('syncCursor', '')
    report(
      onProgress,
      {
        kind: 'sparse',
        stage: 'reconciling',
        filesDone: page.files.length,
        filesTotal: page.files.length,
        indexed,
        skipped,
        currentPath: null
      },
      { force: true }
    )
    // Continuation pages that exhaust the tree are not the full file set.
    let seen: Set<string>
    if (page.exhausted && startAfter == null) {
      seen = pageSeen
    } else {
      const allFiles = await collectWorkspaceFiles(
        workspaceRoot,
        pageCap != null ? Math.max(RECONCILE_WALK_CAP, pageCap * 2) : undefined,
        signal,
        CODE_INDEX_EXTS,
        INDEX_SKIP_DIR_SEGMENTS
      )
      throwIfAborted(signal)
      seen = new Set<string>()
      for (const f of allFiles) {
        if (!isIndexableSourcePath(f.rel, f.full)) continue
        try {
          if (statSync(f.full).isFile()) seen.add(f.rel)
        } catch (err) {
          if (!isMissingPathError(err) && store.getFileHash(f.rel)) seen.add(f.rel)
        }
      }
    }
    removed = reconcileStaleFiles(store, seen)
  } else {
    store.setMeta('syncComplete', 'false')
    if (page.lastRel) store.setMeta('syncCursor', page.lastRel)
  }

  store.setMeta('lastIndexedAt', new Date().toISOString())
  report(
    onProgress,
    {
      kind: 'sparse',
      stage: 'done',
      filesDone: page.files.length,
      filesTotal: page.files.length,
      indexed,
      skipped,
      removed,
      currentPath: null
    },
    { force: true }
  )
  return {
    scanned: page.files.length,
    indexed,
    skipped,
    removed,
    partial,
    syncComplete,
    cursor
  }
}
