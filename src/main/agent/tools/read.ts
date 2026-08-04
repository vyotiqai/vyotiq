import { resolveInsideWorkspace } from '../../workspace/safePath'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from 'fs'
import { basename, dirname, join } from 'path'

const MAX_BYTES = 512 * 1024
/** Shared with the tools dispatcher — model-facing content cap matches disk read cap. */
export const READ_CONTENT_CAP = MAX_BYTES
/** Line slicing needs the whole file in memory, so it gets a wider but finite cap. */
export const READ_LINE_RANGE_MAX_BYTES = 8 * 1024 * 1024
const LINE_RANGE_MAX_BYTES = READ_LINE_RANGE_MAX_BYTES
/** Directory listing when `read` is pointed at a directory. */
export const READ_DIR_LIST_CAP = 80
const DIR_LIST_CAP = READ_DIR_LIST_CAP
const SUGGEST_CAP = 8

export type ReadOptions = {
  offset?: number
  limit?: number
  startLine?: number
  endLine?: number
}

function listDirectoryEntries(resolved: string, relPath: string): string {
  const entries = readdirSync(resolved, { withFileTypes: true })
    .slice(0, DIR_LIST_CAP)
    .map((e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`)
  const suffix =
    entries.length >= DIR_LIST_CAP ? `\n… (listing capped at ${DIR_LIST_CAP})` : ''
  return [
    `Path is a directory, not a file: ${relPath}`,
    'Contents:',
    ...entries,
    suffix,
    'Use read on a file path, or search/terminal to explore further.'
  ]
    .filter(Boolean)
    .join('\n')
}

function suggestSimilarPaths(workspaceRoot: string, relPath: string): string[] {
  const parent = dirname(relPath)
  const target = basename(relPath).toLowerCase()
  const parentResolved =
    parent === '.' ? workspaceRoot : resolveInsideWorkspace(workspaceRoot, parent)
  if (!existsSync(parentResolved)) return []
  try {
    const names = readdirSync(parentResolved)
    const fuzzy = names
      .filter((name) => {
        const lower = name.toLowerCase()
        const targetStem = target.replace(/\.[^.]+$/, '')
        const nameStem = lower.replace(/\.[^.]+$/, '')
        return (
          lower.includes(target) ||
          target.includes(nameStem) ||
          nameStem.includes(targetStem) ||
          targetStem.includes(nameStem)
        )
      })
      .slice(0, SUGGEST_CAP)
      .map((name) => (parent === '.' ? name : join(parent, name)).replace(/\\/g, '/'))
    if (fuzzy.length) return fuzzy
    return names
      .slice(0, SUGGEST_CAP)
      .map((name) => (parent === '.' ? name : join(parent, name)).replace(/\\/g, '/'))
  } catch {
    return []
  }
}

function formatMissingFileHint(workspaceRoot: string, relPath: string): string {
  const suggestions = suggestSimilarPaths(workspaceRoot, relPath)
  if (!suggestions.length) {
    return `File not found: ${relPath}. Verify the path exists in this workspace.`
  }
  return [
    `File not found: ${relPath}`,
    'Similar names in parent directory:',
    ...suggestions.map((s) => `- ${s}`)
  ].join('\n')
}

/** Shared by read/delete so missing-path errors stay consistent for the model. */
export function missingPathHint(workspaceRoot: string, relPath: string): string {
  return formatMissingFileHint(workspaceRoot, relPath)
}

export function toolRead(
  workspaceRoot: string,
  pathArg: string,
  options: ReadOptions = {}
): string {
  const resolved = resolveInsideWorkspace(workspaceRoot, pathArg)
  if (!existsSync(resolved)) {
    throw new Error(formatMissingFileHint(workspaceRoot, pathArg))
  }
  const st = statSync(resolved)
  if (st.isDirectory()) {
    return listDirectoryEntries(resolved, pathArg)
  }
  if (!st.isFile()) {
    throw new Error(`Not a file: ${pathArg}`)
  }

  if (options.startLine !== undefined || options.endLine !== undefined) {
    return readLineRange(resolved, pathArg, st.size, options)
  }

  const offset = Math.max(0, options.offset ?? 0)
  const limit = options.limit

  if (limit !== undefined || offset > 0) {
    const buf = readFileSync(resolved)
    if (buf.includes(0)) {
      throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
    }
    const slice = buf.subarray(offset, limit !== undefined ? offset + limit : undefined)
    const header = `--- offset ${offset}${limit !== undefined ? `, limit ${limit}` : ''} of ${st.size} bytes ---\n`
    return header + slice.toString('utf8')
  }

  if (st.size > MAX_BYTES) {
    throw new Error(
      `File too large (${st.size} bytes, cap ${MAX_BYTES}). Use startLine/endLine to read a portion.`
    )
  }
  const buf = readFileSync(resolved)
  if (buf.includes(0)) {
    throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
  }
  return buf.toString('utf8')
}

/**
 * Read an inclusive, 1-based line range. The header states the range actually
 * returned, which is both what the model needs to cite and what the transcript
 * shows next to the file name.
 */
function readLineRange(
  resolved: string,
  pathArg: string,
  size: number,
  options: ReadOptions
): string {
  if (size > LINE_RANGE_MAX_BYTES) {
    throw new Error(
      `File too large to slice by line (${size} bytes, cap ${LINE_RANGE_MAX_BYTES}). Use offset/limit instead.`
    )
  }

  const buf = readFileSync(resolved)
  if (buf.includes(0)) {
    throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
  }

  const lines = buf.toString('utf8').split('\n')
  // A trailing newline terminates the last line rather than starting a new one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  const total = lines.length
  const start = Math.max(1, Math.trunc(options.startLine ?? 1))
  const end = Math.min(total, Math.trunc(options.endLine ?? total))

  if (start > total) {
    throw new Error(`startLine ${start} is past the end of ${pathArg} (${total} lines).`)
  }
  if (end < start) {
    throw new Error(`endLine ${end} is before startLine ${start}.`)
  }

  const header = `--- lines ${start}-${end} of ${total} ---\n`
  return header + lines.slice(start - 1, end).join('\n')
}
