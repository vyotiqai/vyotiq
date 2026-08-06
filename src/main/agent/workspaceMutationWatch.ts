import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { canonicalizeWorkspacePath } from '../../shared/utils/workspacePath'
import { IGNORED_DIRS } from './tools/walk'
import { getWriteCheckpoint, type InvokeWriteCheckpoint } from './checkpoints'
import { logger } from '../../shared/logger'

export type WorkspaceFileFingerprint = {
  rel: string
  full: string
  mtimeMs: number
  size: number
  /** Absolute path to a prior-content blob when snapshotted. */
  blobPath?: string
}

export type WorkspaceSnapshot = {
  root: string
  files: Map<string, WorkspaceFileFingerprint>
  blobDir: string
}

export type WorkspaceDiff = {
  created: string[]
  modified: string[]
  deleted: string[]
}

const SNAPSHOT_BLOB_MAX_BYTES = 1_048_576
const SNAPSHOT_FILE_CAP = 5_000

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/')
}

function walkSync(root: string, cap: number): WorkspaceFileFingerprint[] {
  const realRoot = canonicalizeWorkspacePath(root)
  const out: WorkspaceFileFingerprint[] = []
  const queue: Array<{ dir: string; relDir: string }> = [{ dir: realRoot, relDir: '' }]

  while (queue.length > 0 && out.length < cap) {
    const next = queue.shift()!
    let entries
    try {
      entries = readdirSync(next.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= cap) break
      if (IGNORED_DIRS.has(entry.name)) continue
      if (entry.isSymbolicLink()) continue
      const full = join(next.dir, entry.name)
      const childRel = normalizeRel(next.relDir ? `${next.relDir}/${entry.name}` : entry.name)
      if (entry.isDirectory()) {
        queue.push({ dir: full, relDir: childRel })
        continue
      }
      if (!entry.isFile()) continue
      try {
        const st = statSync(full)
        out.push({
          rel: childRel,
          full,
          mtimeMs: st.mtimeMs,
          size: st.size
        })
      } catch {
        // skip unreadable entries
      }
    }
  }
  if (out.length >= cap) {
    logger.warn('Workspace snapshot file cap reached; checkpoint diff may be incomplete', {
      scope: 'workspaceMutationWatch',
      cap,
      root: realRoot
    })
  }
  return out
}

/** Take a pre-mutation workspace fingerprint (with prior blobs for small files). */
export function startWatch(workspaceRoot: string): WorkspaceSnapshot {
  const blobDir = join(tmpdir(), `vyotiq-ws-snap-${process.pid}-${randomUUID()}`)
  mkdirSync(blobDir, { recursive: true })
  const files = new Map<string, WorkspaceFileFingerprint>()
  for (const fp of walkSync(workspaceRoot, SNAPSHOT_FILE_CAP)) {
    let blobPath: string | undefined
    if (fp.size <= SNAPSHOT_BLOB_MAX_BYTES) {
      try {
        const dest = join(blobDir, ...fp.rel.split('/'))
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(fp.full, dest)
        blobPath = dest
      } catch {
        blobPath = undefined
      }
    }
    files.set(fp.rel, { ...fp, blobPath })
  }
  return { root: workspaceRoot, files, blobDir }
}

export function diffSince(snapshot: WorkspaceSnapshot): WorkspaceDiff {
  const current = new Map(
    walkSync(snapshot.root, SNAPSHOT_FILE_CAP).map((f) => [f.rel, f] as const)
  )
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const [rel, now] of current) {
    const before = snapshot.files.get(rel)
    if (!before) {
      created.push(rel)
      continue
    }
    if (before.mtimeMs !== now.mtimeMs || before.size !== now.size) {
      modified.push(rel)
    }
  }
  for (const rel of snapshot.files.keys()) {
    if (!current.has(rel)) deleted.push(rel)
  }
  return { created, modified, deleted }
}

export function disposeWatch(snapshot: WorkspaceSnapshot): void {
  try {
    rmSync(snapshot.blobDir, { recursive: true, force: true })
  } catch (err) {
    logger.warn('Failed to dispose workspace mutation snapshot', {
      scope: 'agent',
      err
    })
  }
}

/**
 * Apply a post-tool workspace diff onto the active write checkpoint, using
 * pre-mutation blobs from the snapshot for modified/deleted paths.
 */
export function applyWatchDiffToCheckpoint(
  snapshot: WorkspaceSnapshot,
  diff: WorkspaceDiff,
  context: { runDir?: string; skipWriteCheckpoint?: boolean }
): void {
  if (context.skipWriteCheckpoint || !context.runDir) return
  const cp = getWriteCheckpoint(context.runDir)
  if (!cp) return

  for (const rel of diff.created) {
    cp.recordObservedMutation(rel, 'created')
  }
  for (const rel of diff.modified) {
    const prior = snapshot.files.get(rel)
    cp.recordObservedMutation(rel, 'modified', prior?.blobPath)
  }
  for (const rel of diff.deleted) {
    const prior = snapshot.files.get(rel)
    cp.recordObservedMutation(rel, 'deleted', prior?.blobPath)
  }
}

export type { InvokeWriteCheckpoint }
