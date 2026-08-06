import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { resolveInsideWorkspace, assertResolvedInsideWorkspace } from '../../workspace/safePath'
import { applyUnifiedDiff } from './edit'
import { throwIfAborted } from './walk'
import { assertWritableTextContent } from './writeGuard'

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
  action: 'wrote' | 'patched'
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
  signal?: AbortSignal
): string {
  if (!edits.length) throw new Error('multi_edit requires at least one edit')

  const planned: Planned[] = []
  const seen = new Set<string>()

  for (const [index, edit] of edits.entries()) {
    const path = String(edit.path ?? '').trim()
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

    if (typeof edit.contents === 'string') {
      assertWritableTextContent(path, edit.contents)
      planned.push({ path, resolved, next: edit.contents, action: 'wrote' })
      continue
    }
    if (typeof edit.diff === 'string' && edit.diff.trim()) {
      const original = existsSync(resolved) ? readFileSync(resolved, 'utf8') : ''
      try {
        const next = applyUnifiedDiff(original, edit.diff)
        assertWritableTextContent(path, next)
        planned.push({
          path,
          resolved,
          next,
          action: 'patched'
        })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(`multi_edit aborted, no files changed - ${path}: ${detail}`)
      }
      continue
    }
    throw new Error(`multi_edit edit #${index + 1} (${path}) requires contents or diff`)
  }

  // All-or-nothing disk phase: stage every file at a temp sibling first, then
  // rename into place. Any failure/abort before the rename loop deletes temps
  // and leaves the workspace untouched.
  const temps: Array<{ temp: string; resolved: string }> = []
  try {
    for (const entry of planned) {
      throwIfAborted(signal)
      assertResolvedInsideWorkspace(workspaceRoot, dirname(entry.resolved))
      mkdirSync(dirname(entry.resolved), { recursive: true })
      assertResolvedInsideWorkspace(workspaceRoot, entry.resolved)
      const temp = `${entry.resolved}.tmp`
      writeFileSync(temp, entry.next, { encoding: 'utf8', mode: 0o644 })
      temps.push({ temp, resolved: entry.resolved })
    }
    // Commit point: an abort observed before the first rename still leaves the
    // workspace untouched (catch deletes temps). The rename loop itself stays
    // check-free on purpose — stopping mid-rename would recreate partial state.
    throwIfAborted(signal)
    for (const { temp, resolved } of temps) {
      renameSync(temp, resolved)
    }
  } catch (err) {
    for (const { temp } of temps) {
      try {
        unlinkSync(temp)
      } catch {
        // ignore — temp may not exist or already be renamed
      }
    }
    throw err
  }

  return [
    `Applied ${planned.length} edit${planned.length === 1 ? '' : 's'}:`,
    ...planned.map((entry) => `- ${entry.action} ${entry.path}`)
  ].join('\n')
}
