import { promises as fsp } from 'fs'
import { chunkSourceAst } from './chunkAst'
import { chunkContentHash, sha256Text } from './hash'
import type { Embedder } from './embed'
import { CodeIndexStore, buildChunkFtsText } from './store'
import {
  CODE_INDEX_EXTS,
  collectWorkspaceFiles,
  collectWorkspaceFilesPage,
  INDEX_SKIP_DIR_SEGMENTS,
  isDenseIndexPath,
  throwIfAborted,
  yieldToEventLoop,
  type WalkedFile
} from '../tools/walk'
import {
  CODE_INDEX_MAX_FILE_BYTES,
  denseModelIdsCompatible,
  isLightOnDenseModelId,
  shouldPreserveIndexedEmbeddings,
  type CodeChunk,
  type IndexStatus
} from './types'
import {
  publishIndexSyncProgress,
  type IndexProgressUpdate
} from './indexProgress'

/**
 * Yield periodically so crawl/SQLite on main stays responsive without
 * paying setImmediate per file (YIELD_EVERY=1 was a major sync tax).
 */
const YIELD_EVERY = 32
/** Max files considered per dense index page (production source). */
export const INDEX_SCAN_CAP = 24000
/** Full-tree reconcile walk after the last page (must exceed one page). */
export const CODE_INDEX_RECONCILE_WALK_CAP = INDEX_SCAN_CAP * 2
/**
 * Similar-length groups. Mixed batch 32 paid pad-to-longest tax;
 * per-chunk forwards paid call overhead. Same-bucket pad stays small.
 */
export const CODE_INDEX_EMBED_BATCH = 16
const EMBED_BATCH = CODE_INDEX_EMBED_BATCH
const EMBED_LENGTH_BUCKET_EDGES = [256, 512, 1024, 2048] as const
const EMBED_BUCKET_COUNT = EMBED_LENGTH_BUCKET_EDGES.length + 1

/** Map chunk character length to a pad-similar embed bucket. */
export function embedLengthBucket(charLen: number): number {
  const n = Number.isFinite(charLen) ? Math.max(0, Math.floor(charLen)) : 0
  for (let i = 0; i < EMBED_LENGTH_BUCKET_EDGES.length; i++) {
    if (n <= EMBED_LENGTH_BUCKET_EDGES[i]!) return i
  }
  return EMBED_LENGTH_BUCKET_EDGES.length
}
const MAX_FILE_BYTES = CODE_INDEX_MAX_FILE_BYTES
const PROGRESS_THROTTLE_MS = 75

function roundMtime(mtimeMs: number): number {
  return Math.round(mtimeMs)
}

function isMissingPathError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err != null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  )
}

function isCodeIndexPath(rel: string, full: string): boolean {
  return isDenseIndexPath(rel, full)
}

type PendingIndexFile = {
  rel: string
  fileHash: string
  mtimeMs: number
  size: number
  chunks: CodeChunk[]
  chunkHashes: string[]
  embeddings: Array<Float32Array | undefined>
  pendingSlots: number
  embedPending: boolean
}

type EmbedSlot = {
  file: PendingIndexFile
  chunkIndex: number
}

export type SyncResult = {
  scanned: number
  indexed: number
  skipped: number
  removed: number
  status: IndexStatus
  partial: boolean
  syncComplete: boolean
  cursor: string | null
}

export type SyncCodeIndexOptions = {
  signal?: AbortSignal
  /**
   * Optional precollected walk. When `pageCap` is set and the list is at least
   * that long, treat as a partial page (do not `deleteFilesNotIn`).
   */
  files?: WalkedFile[]
  /** Optional progress sink (utility child posts; main uses publishIndexSyncProgress). */
  onProgress?: (update: IndexProgressUpdate, opts?: { force?: boolean }) => void
  /**
   * Transient neural embedder failure: keep existing vectors, FTS-index new
   * files with embed_pending instead of writing hash vectors.
   */
  preserveNeural?: boolean
  /** Page size for paged walks. Tests pass a small cap; production uses INDEX_SCAN_CAP. */
  pageCap?: number
}

type ReadTextResult = { ok: true; text: string } | { ok: false; missing: boolean }
type StatResult =
  | { ok: true; size: number; mtimeMs: number }
  | { ok: false; missing: boolean }

async function readTextFile(full: string): Promise<ReadTextResult> {
  try {
    return { ok: true, text: await fsp.readFile(full, 'utf8') }
  } catch (err) {
    return { ok: false, missing: isMissingPathError(err) }
  }
}

async function statFile(full: string): Promise<StatResult> {
  try {
    const st = await fsp.stat(full)
    if (!st.isFile()) return { ok: false, missing: false }
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs }
  } catch (err) {
    return { ok: false, missing: isMissingPathError(err) }
  }
}

function report(
  onProgress: SyncCodeIndexOptions['onProgress'],
  update: IndexProgressUpdate,
  opts?: { force?: boolean }
): void {
  if (onProgress) {
    onProgress(update, opts)
    return
  }
  publishIndexSyncProgress(update, opts)
}

/** Throttle custom onProgress sinks the same way as publishIndexSyncProgress. */
function createThrottledProgress(
  onProgress: SyncCodeIndexOptions['onProgress']
): SyncCodeIndexOptions['onProgress'] {
  if (!onProgress) return undefined
  let last = 0
  return (update, opts) => {
    const now = Date.now()
    if (!opts?.force && now - last < PROGRESS_THROTTLE_MS) return
    last = now
    onProgress(update, opts)
  }
}

async function collectCodeIndexPage(
  workspaceRoot: string,
  store: CodeIndexStore,
  pageCap: number | undefined,
  signal: AbortSignal | undefined
): Promise<{
  files: WalkedFile[]
  exhausted: boolean
  lastRel: string | null
  startAfter: string | undefined
}> {
  const priorCursor = store.getMeta('syncCursor')
  let startAfter = priorCursor && priorCursor.length > 0 ? priorCursor : undefined
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
  return {
    files: page.files.filter((f) => isCodeIndexPath(f.rel, f.full)),
    exhausted: page.exhausted,
    lastRel: page.lastRel,
    startAfter
  }
}

export async function syncCodeIndex(
  workspaceRoot: string,
  store: CodeIndexStore,
  embedder: Embedder,
  signalOrOpts?: AbortSignal | SyncCodeIndexOptions
): Promise<SyncResult> {
  const opts: SyncCodeIndexOptions =
    signalOrOpts != null && typeof signalOrOpts === 'object' && !('aborted' in signalOrOpts)
      ? signalOrOpts
      : { signal: signalOrOpts as AbortSignal | undefined }
  const signal = opts.signal
  const onProgress = createThrottledProgress(opts.onProgress)

  throwIfAborted(signal)
  const prevModelId = store.getMeta('modelId')
  const prevDimensions = store.getMeta('dimensions')
  const preservingNeural = shouldPreserveIndexedEmbeddings({
    usedFallback: opts.preserveNeural === true,
    storeModelId: prevModelId,
    storeChunkCount: store.getStatus().chunkCount
  })
  // Same sqlite path for all models — file SHA skip must not keep foreign embeddings.
  // Lazy mDenseOn placeholder vs stored DenseOn-ONNX is the same family, not a model change.
  const modelChanged =
    !preservingNeural &&
    ((prevModelId != null && !denseModelIdsCompatible(prevModelId, embedder.modelId)) ||
      (prevDimensions != null && prevDimensions !== String(embedder.dimensions)))
  const hashModelId =
    prevModelId &&
      isLightOnDenseModelId(prevModelId) &&
      isLightOnDenseModelId(embedder.modelId)
      ? prevModelId
      : embedder.modelId

  report(
    onProgress,
    {
      kind: 'code',
      stage: 'walking',
      filesDone: 0,
      filesTotal: 0,
      indexed: 0,
      skipped: 0,
      embedChunks: 0,
      currentPath: null
    },
    { force: true }
  )

  let files: WalkedFile[]
  let batchComplete = true
  let pageLastRel: string | null = null
  let pageStartAfter: string | undefined
  const pageCap = opts.pageCap ?? INDEX_SCAN_CAP

  if (opts.files != null) {
    files = opts.files.filter((f) => isCodeIndexPath(f.rel, f.full))
    const capped =
      opts.pageCap != null && Number.isFinite(opts.pageCap) && opts.files.length >= opts.pageCap
    batchComplete = !capped
  } else {
    const page = await collectCodeIndexPage(workspaceRoot, store, pageCap, signal)
    files = page.files
    pageLastRel = page.lastRel
    pageStartAfter = page.startAfter
    batchComplete =
      page.exhausted || (pageCap != null && Number.isFinite(pageCap) && page.files.length < pageCap)
  }
  throwIfAborted(signal)
  const filesTotal = files.length
  const seen = new Set<string>()
  let indexed = 0
  let skipped = 0
  let embedChunks = 0
  let filesDone = 0
  let currentPath: string | null = null

  const pendingFiles: PendingIndexFile[] = []
  const bucketTexts: string[][] = Array.from({ length: EMBED_BUCKET_COUNT }, () => [])
  const bucketSlots: EmbedSlot[][] = Array.from({ length: EMBED_BUCKET_COUNT }, () => [])

  const commitFile = (file: PendingIndexFile): void => {
    if (!file.embedPending) {
      for (let ci = 0; ci < file.chunks.length; ci++) {
        if (!file.embeddings[ci]) {
          throw new Error(`missing embedding for ${file.rel} chunk ${ci}`)
        }
      }
    }
    store.replaceFileChunks(
      file.rel,
      file.fileHash,
      file.mtimeMs,
      file.chunks.map((c, idx) => ({
        startLine: c.startLine,
        endLine: c.endLine,
        kind: c.kind,
        name: c.name,
        parentName: c.parentName,
        chunkHash: file.chunkHashes[idx]!,
        embedding: file.embeddings[idx] ?? new Float32Array(0),
        ftsText: buildChunkFtsText(file.rel, c)
      })),
      file.size,
      file.embedPending
    )
    seen.add(file.rel)
    indexed++
  }

  const commitReadyPending = (): void => {
    const rest: PendingIndexFile[] = []
    for (const file of pendingFiles) {
      if (file.pendingSlots === 0) commitFile(file)
      else rest.push(file)
    }
    pendingFiles.length = 0
    for (const file of rest) pendingFiles.push(file)
  }

  const flushBucket = async (bucket: number): Promise<void> => {
    const batchTexts = bucketTexts[bucket]!
    const batchSlots = bucketSlots[bucket]!
    if (batchTexts.length === 0) return
    throwIfAborted(signal)
    report(
      onProgress,
      {
        kind: 'code',
        stage: 'embedding',
        filesDone,
        filesTotal,
        indexed,
        skipped,
        embedChunks: embedChunks + batchTexts.length,
        currentPath
      },
      { force: true }
    )
    const part = await embedder.embed(batchTexts, { role: 'document', signal })
    if (part.length !== batchTexts.length) {
      throw new Error(
        `embed batch size mismatch: got ${part.length} for ${batchTexts.length} texts`
      )
    }
    for (let si = 0; si < batchSlots.length; si++) {
      const slot = batchSlots[si]!
      slot.file.embeddings[slot.chunkIndex] = part[si]!
      slot.file.pendingSlots--
    }
    embedChunks += batchTexts.length
    batchTexts.length = 0
    batchSlots.length = 0
    commitReadyPending()
    await yieldToEventLoop()
    throwIfAborted(signal)
  }

  const flushEmbedBatch = async (): Promise<void> => {
    for (let b = 0; b < EMBED_BUCKET_COUNT; b++) await flushBucket(b)
  }

  const enqueueChunk = async (
    file: PendingIndexFile,
    chunkIndex: number,
    text: string
  ): Promise<void> => {
    file.pendingSlots++
    const bucket = embedLengthBucket(text.length)
    bucketTexts[bucket]!.push(text)
    bucketSlots[bucket]!.push({ file, chunkIndex })
    if (bucketTexts[bucket]!.length >= EMBED_BATCH) await flushBucket(bucket)
  }

  report(
    onProgress,
    {
      kind: 'code',
      stage: 'scanning',
      filesDone: 0,
      filesTotal,
      indexed: 0,
      skipped: 0,
      embedChunks: 0,
      currentPath: null
    },
    { force: true }
  )

  for (let i = 0; i < files.length; i++) {
    throwIfAborted(signal)
    if (i > 0 && i % YIELD_EVERY === 0) {
      await yieldToEventLoop()
      throwIfAborted(signal)
    }
    const { full, rel } = files[i]!
    filesDone = i + 1
    currentPath = rel
    const st = await statFile(full)
    if (!st.ok) {
      if (!st.missing && store.getFileHash(rel)) seen.add(rel)
      skipped++
      report(onProgress, {
        kind: 'code',
        stage: 'scanning',
        filesDone,
        filesTotal,
        indexed,
        skipped,
        embedChunks,
        currentPath: rel
      })
      continue
    }
    if (st.size > MAX_FILE_BYTES) {
      skipped++
      report(onProgress, {
        kind: 'code',
        stage: 'scanning',
        filesDone,
        filesTotal,
        indexed,
        skipped,
        embedChunks,
        currentPath: rel
      })
      continue
    }
    const mtimeMs = roundMtime(st.mtimeMs)
    if (!modelChanged) {
      const stamp = store.getFileStamp(rel)
      if (
        stamp &&
        stamp.mtimeMs === mtimeMs &&
        stamp.size === st.size &&
        (!stamp.embedPending || preservingNeural)
      ) {
        seen.add(rel)
        skipped++
        report(onProgress, {
          kind: 'code',
          stage: 'scanning',
          filesDone,
          filesTotal,
          indexed,
          skipped,
          embedChunks,
          currentPath: rel
        })
        continue
      }
    }
    const textResult = await readTextFile(full)
    if (!textResult.ok) {
      if (!textResult.missing && store.getFileHash(rel)) seen.add(rel)
      skipped++
      report(onProgress, {
        kind: 'code',
        stage: 'scanning',
        filesDone,
        filesTotal,
        indexed,
        skipped,
        embedChunks,
        currentPath: rel
      })
      continue
    }
    const text = textResult.text
    if (text.includes('\0')) {
      skipped++
      report(onProgress, {
        kind: 'code',
        stage: 'scanning',
        filesDone,
        filesTotal,
        indexed,
        skipped,
        embedChunks,
        currentPath: rel
      })
      continue
    }
    const fileHash = sha256Text(text)
    if (!modelChanged && store.getFileHash(rel) === fileHash) {
      const stamp = store.getFileStamp(rel)
      if (!stamp?.embedPending || preservingNeural) {
        store.updateFileStamp(rel, fileHash, mtimeMs, st.size)
        seen.add(rel)
        skipped++
        report(onProgress, {
          kind: 'code',
          stage: 'scanning',
          filesDone,
          filesTotal,
          indexed,
          skipped,
          embedChunks,
          currentPath: rel
        })
        continue
      }
    }
    const chunks = await chunkSourceAst(rel, text)
    const chunkHashes = chunks.map((c) =>
      chunkContentHash(hashModelId, rel, c.startLine, c.endLine, c.text)
    )
    const pending: PendingIndexFile = {
      rel,
      fileHash,
      mtimeMs,
      size: st.size,
      chunks,
      chunkHashes,
      embeddings: new Array(chunks.length),
      pendingSlots: 0,
      embedPending: preservingNeural
    }
    if (preservingNeural) {
      for (let ci = 0; ci < chunks.length; ci++) {
        pending.embeddings[ci] = new Float32Array(0)
      }
      commitFile(pending)
      report(onProgress, {
        kind: 'code',
        stage: 'scanning',
        filesDone,
        filesTotal,
        indexed,
        skipped,
        embedChunks,
        currentPath: rel
      })
      continue
    }
    const reused = store.getEmbeddingsByChunkHashes(chunkHashes)
    for (let ci = 0; ci < chunks.length; ci++) {
      const cached = reused.get(chunkHashes[ci]!)
      if (cached) {
        pending.embeddings[ci] = cached
        continue
      }
      await enqueueChunk(pending, ci, chunks[ci]!.contextualizedText)
    }
    if (pending.pendingSlots === 0) commitFile(pending)
    else pendingFiles.push(pending)
    report(onProgress, {
      kind: 'code',
      stage: 'scanning',
      filesDone,
      filesTotal,
      indexed,
      skipped,
      embedChunks,
      currentPath: rel
    })
  }

  await flushEmbedBatch()
  if (pendingFiles.length > 0) {
    throw new Error(`code index embed flush left ${pendingFiles.length} files pending`)
  }

  let removed = 0
  let partial = !batchComplete
  let syncComplete = batchComplete
  let cursor: string | null = batchComplete ? null : pageLastRel

  if (batchComplete) {
    store.setMeta('syncComplete', 'true')
    store.setMeta('syncCursor', '')
    report(
      onProgress,
      {
        kind: 'code',
        stage: 'reconciling',
        filesDone: filesTotal,
        filesTotal,
        indexed,
        skipped,
        embedChunks,
        currentPath: null
      },
      { force: true }
    )
    throwIfAborted(signal)
    let reconcileSeen: Set<string>
    if (opts.files != null || pageStartAfter == null) {
      reconcileSeen = seen
    } else {
      const allFiles = await collectWorkspaceFiles(
        workspaceRoot,
        pageCap != null ? Math.max(CODE_INDEX_RECONCILE_WALK_CAP, pageCap * 2) : undefined,
        signal,
        CODE_INDEX_EXTS,
        INDEX_SKIP_DIR_SEGMENTS
      )
      throwIfAborted(signal)
      reconcileSeen = new Set<string>()
      for (const f of allFiles) {
        if (!isCodeIndexPath(f.rel, f.full)) continue
        const st = await statFile(f.full)
        if (st.ok) reconcileSeen.add(f.rel)
        else if (!st.missing && store.getFileHash(f.rel)) reconcileSeen.add(f.rel)
      }
    }
    removed = store.deleteFilesNotIn(reconcileSeen)
  } else {
    store.setMeta('syncComplete', 'false')
    if (pageLastRel) store.setMeta('syncCursor', pageLastRel)
  }

  if (!preservingNeural && (indexed > 0 || prevModelId == null)) {
    store.setMeta('modelId', embedder.modelId)
    store.setMeta('dimensions', String(embedder.dimensions))
  }
  store.setMeta('lastIndexedAt', new Date().toISOString())
  report(
    onProgress,
    {
      kind: 'code',
      stage: 'done',
      filesDone: filesTotal,
      filesTotal,
      indexed,
      skipped,
      removed,
      embedChunks,
      currentPath: null
    },
    { force: true }
  )

  return {
    scanned: files.length,
    indexed,
    skipped,
    removed,
    status: store.getStatus(),
    partial,
    syncComplete,
    cursor
  }
}
