import type { CodeIndexSyncProgress } from '../../../shared/ipc/schemas/settings'
import { setCodeIndexRuntimeStatus } from './modelStatus'

const THROTTLE_MS = 75

let lastPublishAt = 0

export type IndexProgressKind = CodeIndexSyncProgress['kind']
export type IndexProgressStage = CodeIndexSyncProgress['stage']

export type IndexProgressUpdate = {
  kind: IndexProgressKind
  stage: IndexProgressStage
  filesDone: number
  filesTotal: number
  indexed: number
  skipped: number
  removed?: number
  embedChunks?: number
  currentPath?: string | null
}

function fraction(done: number, total: number): number | null {
  if (total <= 0) return null
  return Math.min(0.99, Math.max(0, done / total))
}

function formatMessage(p: CodeIndexSyncProgress): string {
  const counts = `${p.filesDone}/${p.filesTotal} files · ${p.indexed} updated · ${p.skipped} skipped`
  if (p.stage === 'walking') {
    return p.kind === 'code' ? 'Walking workspace (code index)…' : 'Walking workspace (sparse index)…'
  }
  if (p.stage === 'embedding') {
    const path = p.currentPath ? ` · ${p.currentPath}` : ''
    return `Embedding ${p.embedChunks} chunks · ${counts}${path}`
  }
  if (p.stage === 'reconciling') {
    return `Reconciling removed files · ${counts}`
  }
  if (p.stage === 'done') {
    const removed = p.removed > 0 ? ` · ${p.removed} removed` : ''
    return p.kind === 'code'
      ? `Code index ready · ${p.indexed} updated · ${p.skipped} skipped${removed}`
      : `Sparse index ready · ${p.indexed} updated · ${p.skipped} skipped${removed}`
  }
  const path = p.currentPath ? ` · ${p.currentPath}` : ''
  return p.kind === 'code'
    ? `Indexing code · ${counts}${path}`
    : `Indexing sparse grep · ${counts}${path}`
}

/** Push live indexing progress (throttled). Use force for stage boundaries / completion. */
export function publishIndexSyncProgress(update: IndexProgressUpdate, opts?: { force?: boolean }): void {
  const now = Date.now()
  if (!opts?.force && now - lastPublishAt < THROTTLE_MS) return
  lastPublishAt = now

  const indexProgress: CodeIndexSyncProgress = {
    kind: update.kind,
    stage: update.stage,
    filesDone: update.filesDone,
    filesTotal: update.filesTotal,
    indexed: update.indexed,
    skipped: update.skipped,
    removed: update.removed ?? 0,
    embedChunks: update.embedChunks ?? 0,
    currentPath: update.currentPath ?? null
  }

  setCodeIndexRuntimeStatus({
    phase: 'indexing',
    progress: fraction(update.filesDone, update.filesTotal),
    message: formatMessage(indexProgress),
    error: null,
    indexProgress
  })
}

export function clearIndexSyncProgress(): void {
  lastPublishAt = 0
  setCodeIndexRuntimeStatus({
    indexProgress: null
  })
}
