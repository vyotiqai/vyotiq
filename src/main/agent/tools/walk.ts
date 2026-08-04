import { existsSync, readdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { gitignoreMatcherForDir } from './gitignore'
import {
  canonicalizeWorkspacePath,
  isWindowsStylePath
} from '../../../shared/utils/workspacePath'

/** Directories never worth walking, even when .gitignore does not mention them. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.vyotiq',
  'dist',
  'out',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.turbo'
])

export const TEXT_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdc',
  '.txt',
  '.css',
  '.scss',
  '.html',
  '.yml',
  '.yaml',
  '.toml',
  '.rs',
  '.go',
  '.py',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.sh',
  '.ps1',
  '.sql',
  '.vue',
  '.svelte'
])

/** Yield the event loop so long scans stay responsive to abort/cancel. */
const YIELD_EVERY_DIRS = 64

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

export type WalkedFile = {
  /** Absolute path on disk. */
  full: string
  /** Workspace-relative path with forward slashes. */
  rel: string
}

function pathKey(path: string): string {
  return isWindowsStylePath(path) ? path.toLowerCase() : path
}

function isInsideRoot(resolved: string, realRoot: string): boolean {
  const rootKey = pathKey(canonicalizeWorkspacePath(realRoot))
  const resolvedKey = pathKey(canonicalizeWorkspacePath(resolved))
  const sep = isWindowsStylePath(realRoot) ? '\\' : '/'
  return resolvedKey === rootKey || resolvedKey.startsWith(rootKey + sep)
}

/** True when the path exists and its realpath stays inside the workspace root. */
function isContainedInWorkspace(full: string, realRoot: string): boolean {
  try {
    if (!existsSync(full)) return false
    return isInsideRoot(realpathSync(full), realRoot)
  } catch {
    return false
  }
}

/**
 * Breadth-first workspace walk that honours .gitignore. Shared by search, glob
 * and grep so all three agree on what counts as part of the project.
 * Symlinks are skipped so walks cannot escape via links (same rule as safePath).
 */
export async function collectWorkspaceFiles(
  workspaceRoot: string,
  cap: number,
  signal?: AbortSignal
): Promise<WalkedFile[]> {
  const files: WalkedFile[] = []
  const realRoot = realpathSync(canonicalizeWorkspacePath(workspaceRoot))
  const queue: Array<{ dir: string; relDir: string }> = [{ dir: realRoot, relDir: '' }]
  let scanned = 0

  while (queue.length > 0) {
    throwIfAborted(signal)
    if (files.length >= cap) break

    const next = queue.shift()!
    scanned += 1
    if (scanned > 1 && scanned % YIELD_EVERY_DIRS === 0) {
      await yieldToEventLoop()
      throwIfAborted(signal)
    }

    const dirMatcher = gitignoreMatcherForDir(workspaceRoot, next.relDir)
    let entries
    try {
      entries = readdirSync(next.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      throwIfAborted(signal)
      if (files.length >= cap) break
      if (IGNORED_DIRS.has(entry.name)) continue
      // Never follow symlinks — a link inside the tree can point outside.
      if (entry.isSymbolicLink()) continue
      if (dirMatcher.shouldIgnoreEntry(entry.name, entry.isDirectory())) continue
      const full = join(next.dir, entry.name)
      const childRel = (next.relDir ? `${next.relDir}/${entry.name}` : entry.name).replace(
        /\\/g,
        '/'
      )
      if (!isContainedInWorkspace(full, realRoot)) continue
      if (entry.isDirectory()) {
        queue.push({ dir: full, relDir: childRel })
      } else if (entry.isFile()) {
        files.push({ full, rel: childRel })
      }
    }
  }

  return files
}

/**
 * Translate a glob to a regex. Supports `**`, `*`, `?` and `{a,b}` — the subset
 * models actually reach for, without pulling in a matcher dependency.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  let out = ''
  let i = 0

  while (i < normalized.length) {
    const ch = normalized[i]!
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` may match zero directories, so the slash is part of the group.
        if (normalized[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (ch === '{') {
      const close = normalized.indexOf('}', i)
      if (close > i) {
        const alternatives = normalized
          .slice(i + 1, close)
          .split(',')
          .map((part) => part.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'))
        out += `(?:${alternatives.join('|')})`
        i = close + 1
        continue
      }
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i += 1
  }

  return new RegExp(`^${out}$`, 'i')
}
