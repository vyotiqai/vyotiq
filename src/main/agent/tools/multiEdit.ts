import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'
import { resolveInsideWorkspace, assertResolvedInsideWorkspace } from '../../workspace/safePath'
import { withExclusiveWorkspaceMutation } from '@main/workspace/mutationQueue'
import { renameSyncWithRetry } from '@main/storage/atomicWrite'
import { applyUnifiedDiff } from './edit'
import { throwIfAborted } from './walk'
import { readEditBody, readPathArg } from './argAccess'
import { assertWritablePath } from './writeGuard'

export type MultiEditEntry = {
  path: string
  contents?: string
  diff?: string
  /** Rejected — models sometimes pass str_replace fields here by mistake. */
  old_string?: unknown
  new_string?: unknown
}

type Planned = {
  path: string
  resolved: string
  next: string
  action: 'created' | 'wrote' | 'patched'
}

type StagedTemp = { temp: string; resolved: string }
type Committed = { resolved: string; backup: string | null }

export type MultiEditDiskDeps = {
  renameSyncFn?: (from: string, to: string) => void
}

function commitRename(from: string, to: string, disk?: MultiEditDiskDeps): void {
  if (!disk?.renameSyncFn) {
    renameSyncWithRetry(from, to)
    return
  }
  const renameSyncFn = disk.renameSyncFn
  renameSyncWithRetry(from, to, {
    renameSyncFn: (src, dest) => renameSyncFn(String(src), String(dest))
  })
}

function uniqueSibling(target: string, kind: 'tmp' | 'bak'): string {
  return `${target}.${process.pid}.${randomBytes(4).toString('hex')}.${kind}`
}

function writeExclusiveTemp(workspaceRoot: string, resolved: string, contents: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const temp = uniqueSibling(resolved, 'tmp')
    assertResolvedInsideWorkspace(workspaceRoot, temp)
    try {
      writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
      return temp
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('multi_edit could not allocate an exclusive temp file')
}

function rollbackCommit(commit: Committed, disk?: MultiEditDiskDeps): void {
  if (commit.backup) {
    if (existsSync(commit.resolved)) {
      unlinkSync(commit.resolved)
    }
    commitRename(commit.backup, commit.resolved, disk)
    return
  }
  if (existsSync(commit.resolved)) {
    unlinkSync(commit.resolved)
  }
}

/**
 * Apply several file edits as one unit.
 *
 * Every edit is resolved and applied in memory first: a diff that fails to
 * match halfway through a batch would otherwise leave the workspace in a state
 * neither the model nor the user asked for.
 */
export function toolMultiEdit(
  workspaceRoot: string,
  edits: MultiEditEntry[],
  signal?: AbortSignal,
  disk?: MultiEditDiskDeps
): string {
  if (!edits.length) throw new Error('multi_edit requires at least one edit')

  const planned: Planned[] = []
  const seen = new Set<string>()

  for (const [index, edit] of edits.entries()) {
    const path = readPathArg(edit as Record<string, unknown>) ?? ''
    if (!path) throw new Error(`multi_edit edit #${index + 1} is missing a path`)
    if (edit.old_string !== undefined || edit.new_string !== undefined) {
      throw new Error(
        `multi_edit edit #${index + 1} includes old_string/new_string - use str_replace for exact string edits (multi_edit accepts contents or diff only)`
      )
    }
    const resolved = resolveInsideWorkspace(workspaceRoot, path)

    if (seen.has(resolved)) {
      throw new Error(
        `multi_edit lists ${path} twice; combine them into one edit so the result is unambiguous`
      )
    }
    seen.add(resolved)

    const { contents, diff } = readEditBody(edit as Record<string, unknown>)
    const existed = existsSync(resolved)
    if (typeof contents === 'string') {
      if (existed && contents.length === 0 && statSync(resolved).size > 0) {
        throw new Error(
          `multi_edit aborted, no files changed - ${path}: refusing to replace a non-empty file with empty contents; use diff to remove contents explicitly`
        )
      }
      assertWritablePath(path)
      planned.push({
        path,
        resolved,
        next: contents,
        action: existed ? 'wrote' : 'created'
      })
      continue
    }
    if (typeof diff === 'string' && diff.trim()) {
      const original = existed ? readFileSync(resolved, 'utf8') : ''
      try {
        const next = applyUnifiedDiff(original, diff)
        assertWritablePath(path)
        planned.push({
          path,
          resolved,
          next,
          action: existed ? 'patched' : 'created'
        })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(`multi_edit aborted, no files changed - ${path}: ${detail}`)
      }
      continue
    }
    throw new Error(`multi_edit edit #${index + 1} (${path}) requires contents or diff`)
  }

  // All-or-nothing disk phase: unique exclusive temps, then rename into place
  // with backups so a mid-commit failure can roll completed files back.
  const temps: StagedTemp[] = []
  const commits: Committed[] = []
  let inFlight: Committed | null = null
  try {
    for (const entry of planned) {
      throwIfAborted(signal)
      assertResolvedInsideWorkspace(workspaceRoot, dirname(entry.resolved))
      mkdirSync(dirname(entry.resolved), { recursive: true })
      assertResolvedInsideWorkspace(workspaceRoot, entry.resolved)
      const temp = writeExclusiveTemp(workspaceRoot, entry.resolved, entry.next)
      temps.push({ temp, resolved: entry.resolved })
    }
    throwIfAborted(signal)
    for (const { temp, resolved } of temps) {
      let backup: string | null = null
      if (existsSync(resolved)) {
        backup = uniqueSibling(resolved, 'bak')
        assertResolvedInsideWorkspace(workspaceRoot, backup)
        commitRename(resolved, backup, disk)
      }
      inFlight = { resolved, backup }
      commitRename(temp, resolved, disk)
      inFlight = null
      commits.push({ resolved, backup })
    }
  } catch (err) {
    if (inFlight) {
      try {
        rollbackCommit(inFlight, disk)
      } catch {
        // Preserve the original error; backup may remain for recovery.
      }
      inFlight = null
    }
    for (const commit of [...commits].reverse()) {
      try {
        rollbackCommit(commit, disk)
      } catch {
        // Best-effort; continue remaining rollbacks.
      }
    }
    for (const { temp } of temps) {
      try {
        unlinkSync(temp)
      } catch {
        // ignore — temp may not exist or already be renamed
      }
    }
    throw err
  }

  for (const commit of commits) {
    if (!commit.backup) continue
    try {
      unlinkSync(commit.backup)
    } catch {
      // ignore leftover backup
    }
  }

  return [
    `Applied ${planned.length} edit${planned.length === 1 ? '' : 's'}:`,
    ...planned.map((entry) => `- ${entry.action} ${entry.path}`)
  ].join('\n')
}

export async function toolMultiEditAsync(
  workspaceRoot: string,
  edits: MultiEditEntry[],
  signal?: AbortSignal
): Promise<string> {
  return withExclusiveWorkspaceMutation(workspaceRoot, () =>
    toolMultiEdit(workspaceRoot, edits, signal)
  )
}
