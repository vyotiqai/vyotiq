import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { resolveInsideWorkspace } from '../../workspace/safePath'
import { gitignoreMatcherForDir } from './gitignore'
import { IGNORED_DIRS } from './walk'

/** Max entries returned in one listing. */
export const LIST_DIR_CAP = 200
const DEFAULT_CAP = LIST_DIR_CAP

function normalizeRelDir(pathArg: string): string {
  const rel = pathArg.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return rel === '.' ? '' : rel
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

/** List one directory level, skipping ignored and gitignored entries. */
export function toolListDir(workspaceRoot: string, pathArg = '.', cap = DEFAULT_CAP): string {
  const relDir = normalizeRelDir(pathArg)
  const resolved = resolveInsideWorkspace(workspaceRoot, relDir || '.')
  if (!existsSync(resolved)) {
    throw new Error(`Directory not found: ${pathArg}`)
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${pathArg}. Use read for files.`)
  }

  const matcher = gitignoreMatcherForDir(workspaceRoot, relDir)
  const entries = readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => {
      if (IGNORED_DIRS.has(entry.name)) return false
      return !matcher.shouldIgnoreEntry(entry.name, entry.isDirectory())
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  const shown = entries.slice(0, cap).map((entry) => {
    if (entry.isDirectory()) return `[dir]  ${entry.name}/`
    let size = ''
    try {
      size = ` (${formatSize(statSync(join(resolved, entry.name)).size)})`
    } catch {
      size = ''
    }
    return `[file] ${entry.name}${size}`
  })

  if (shown.length === 0) return `${relDir || '.'} is empty`

  const suffix =
    entries.length > shown.length ? `\n… ${entries.length - shown.length} more entries` : ''
  return [`${relDir || '.'} (${entries.length} entries)`, ...shown].join('\n') + suffix
}
