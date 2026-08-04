import { app } from 'electron'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'fs'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { logger } from '../../shared/logger'
import { canonicalizeWorkspacePath } from '../../shared/workspacePath'
import { workspaceIdFromCanonical, workspaceIdFromPath } from '../../shared/workspaceId'
import { atomicWriteJson } from './atomicWrite'

export type WorkspaceMeta = {
  workspaceId: string
  canonicalPath: string
  displayName?: string
  migratedAt?: string
  runsMigrated?: boolean
}

export function userDataRoot(): string {
  return app.getPath('userData')
}

/** Stable UUID v5 from a canonical workspace path. */
export function workspaceId(canonicalPath: string): string {
  return workspaceIdFromCanonical(canonicalPath)
}

export { workspaceIdFromPath }

export function workspacesRoot(): string {
  return join(userDataRoot(), 'workspaces')
}

export function workspaceMetaDir(id: string): string {
  return join(workspacesRoot(), id)
}

export function workspaceSessionsRoot(workspacePath: string): string {
  const canonical = canonicalizeWorkspacePath(workspacePath)
  return join(workspaceMetaDir(workspaceId(canonical)), 'sessions')
}

/**
 * A run id is attacker-controllable over IPC and ends up in `rmSync`/`writeFileSync`,
 * so the resolved directory must stay a direct child of the sessions root.
 */
export function resolveRunDir(workspacePath: string, runId: string): string {
  const root = workspaceSessionsRoot(workspacePath)
  const dir = resolve(root, runId)
  const rel = relative(root, dir)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel !== basename(rel)) {
    throw new Error(`Invalid run id: ${runId}`)
  }
  if (existsSync(dir)) {
    const st = lstatSync(dir)
    if (st.isSymbolicLink()) {
      throw new Error(`Run dir cannot be a symlink: ${runId}`)
    }
    if (!st.isDirectory()) {
      throw new Error(`Run dir is not a directory: ${runId}`)
    }
    const real = realpathSync(dir)
    const realRel = relative(root, real)
    if (!realRel || realRel.startsWith('..') || isAbsolute(realRel) || realRel !== basename(realRel)) {
      throw new Error(`Invalid run id: ${runId}`)
    }
  }
  return dir
}

export function readWorkspaceMeta(workspacePath: string): WorkspaceMeta | null {
  const canonical = canonicalizeWorkspacePath(workspacePath)
  const id = workspaceId(canonical)
  const metaPath = join(workspaceMetaDir(id), 'meta.json')
  if (!existsSync(metaPath)) return null
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf8')) as WorkspaceMeta
    return raw
  } catch (err) {
    logger.warn('Corrupt workspace meta.json', {
      scope: 'storage',
      workspaceId: id,
      err
    })
    return null
  }
}

export function writeWorkspaceMeta(meta: WorkspaceMeta): void {
  const metaPath = join(workspaceMetaDir(meta.workspaceId), 'meta.json')
  atomicWriteJson(metaPath, meta)
}

/** Creates `workspaces/{id}/meta.json` and `sessions/` for a workspace. */
export function ensureWorkspaceStorage(workspacePath: string): { workspaceId: string } {
  const canonical = canonicalizeWorkspacePath(workspacePath)
  const id = workspaceId(canonical)
  const metaDir = workspaceMetaDir(id)
  const sessionsDir = join(metaDir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })

  const metaPath = join(metaDir, 'meta.json')
  let meta: WorkspaceMeta = {
    workspaceId: id,
    canonicalPath: canonical,
    displayName: basename(canonical)
  }
  if (existsSync(metaPath)) {
    try {
      const existing = JSON.parse(readFileSync(metaPath, 'utf8')) as WorkspaceMeta
      meta = { ...existing, workspaceId: id, canonicalPath: canonical }
    } catch (err) {
      logger.warn('Corrupt workspace meta.json — overwriting', {
        scope: 'storage',
        workspaceId: id,
        err
      })
    }
  }
  atomicWriteJson(metaPath, meta)
  return { workspaceId: id }
}
