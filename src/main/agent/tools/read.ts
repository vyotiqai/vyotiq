import { resolveInsideWorkspace } from '../../workspace/safePath'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from 'fs'
import { basename, dirname, join } from 'path'

const SUGGEST_CAP = 8
const LINE_STREAM_CHUNK = 64 * 1024

export type ReadOptions = {
  offset?: number
  limit?: number
  startLine?: number
  endLine?: number
}

function listDirectoryEntries(resolved: string, relPath: string): string {
  const entries = readdirSync(resolved, { withFileTypes: true }).map(
    (e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`
  )
  return [
    `Path is a directory, not a file: ${relPath}`,
    'Contents:',
    ...entries,
    'Use read on a file path, or list_dir / glob / search to explore further.'
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

/** Decode text files; UTF-16 BOM (common for PowerShell logs) before binary rejection. */
function isUtf16Bom(buf: Buffer): boolean {
  return (
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  )
}

function decodeTextBuffer(buf: Buffer, pathArg: string, encoding: 'utf8' | 'utf16le' = 'utf8'): string {
  if (encoding === 'utf16le') {
    return buf.toString('utf16le')
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) {
      return buf.subarray(2).toString('utf16le')
    }
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      const body = buf.subarray(2)
      const le = Buffer.allocUnsafe(body.length)
      for (let i = 0; i + 1 < body.length; i += 2) {
        le[i] = body[i + 1]!
        le[i + 1] = body[i]!
      }
      return le.toString('utf16le')
    }
  }
  if (buf.includes(0)) {
    throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
  }
  return buf.toString('utf8')
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

  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = options.limit === undefined ? undefined : Math.trunc(options.limit)

  if (limit !== undefined || offset > 0) {
    return readByteRange(resolved, pathArg, st.size, offset, limit)
  }

  const buf = readFileSync(resolved)
  return decodeTextBuffer(buf, pathArg)
}

/**
 * Read a byte window without loading the whole file.
 */
function readByteRange(
  resolved: string,
  pathArg: string,
  size: number,
  offset: number,
  limit: number | undefined
): string {
  if (offset > size) {
    throw new Error(`offset ${offset} is past the end of ${pathArg} (${size} bytes).`)
  }
  const remaining = Math.max(0, size - offset)
  const want = limit === undefined ? remaining : Math.min(Math.max(0, limit), remaining)
  const buf = Buffer.alloc(want)
  const fd = openSync(resolved, 'r')
  let read: number
  try {
    read = want > 0 ? readSync(fd, buf, 0, want, offset) : 0
  } finally {
    closeSync(fd)
  }
  const slice = buf.subarray(0, read)
  // A window starting mid-file has no BOM to inspect; only offset 0 can be UTF-16.
  const utf16 = offset === 0 && isUtf16Bom(slice)
  if (!utf16 && slice.includes(0)) {
    throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
  }
  const header = `--- offset ${offset}${limit !== undefined ? `, limit ${limit}` : ''} of ${size} bytes ---\n`
  const body = utf16 ? decodeTextBuffer(slice, pathArg) : slice.toString('utf8')
  return header + body
}

type LineEncoding = 'utf8' | 'utf16le' | 'utf16be'

function detectLineEncoding(head: Buffer): { encoding: LineEncoding; skip: number } {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    return { encoding: 'utf16le', skip: 2 }
  }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    return { encoding: 'utf16be', skip: 2 }
  }
  return { encoding: 'utf8', skip: 0 }
}

function decodeLineBytes(buf: Buffer, encoding: LineEncoding): string {
  if (encoding === 'utf8') return buf.toString('utf8')
  if (encoding === 'utf16le') return buf.toString('utf16le')
  const le = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i + 1 < buf.length; i += 2) {
    le[i] = buf[i + 1]!
    le[i + 1] = buf[i]!
  }
  return le.toString('utf16le')
}

function splitCompleteLines(
  text: string
): { lines: string[]; leftover: string } {
  const parts = text.split('\n')
  const leftover = parts.pop() ?? ''
  return { lines: parts, leftover }
}

/**
 * Stream an inclusive, 1-based line range without loading the whole file into a string.
 * The header names the range actually returned.
 */
function readLineRange(
  resolved: string,
  pathArg: string,
  size: number,
  options: ReadOptions
): string {
  const startRaw = Math.max(1, Math.trunc(options.startLine ?? 1))
  const endRaw =
    options.endLine == null ? Number.POSITIVE_INFINITY : Math.trunc(options.endLine)
  const start = Number.isFinite(endRaw) && endRaw < startRaw ? Math.max(1, endRaw) : startRaw
  const endLimit = Number.isFinite(endRaw) && endRaw < startRaw ? startRaw : endRaw

  const fd = openSync(resolved, 'r')
  try {
    const peek = Buffer.alloc(Math.min(4, size))
    const peeked = size > 0 ? readSync(fd, peek, 0, peek.length, 0) : 0
    const { encoding, skip } = detectLineEncoding(peek.subarray(0, peeked))
    const unit = encoding === 'utf8' ? 1 : 2

    let leftoverBytes = Buffer.alloc(0)
    let leftoverText = ''
    let offset = skip
    let lineNo = 0
    const collected: string[] = []
    let total = 0
    let sawNul = false

    while (offset < size) {
      const want = Math.min(LINE_STREAM_CHUNK, size - offset)
      const aligned = unit === 1 ? want : want - (want % 2)
      if (aligned <= 0) break
      const buf = Buffer.alloc(aligned)
      const n = readSync(fd, buf, 0, aligned, offset)
      if (n <= 0) break
      offset += n
      let chunk = Buffer.concat([leftoverBytes, buf.subarray(0, n)])
      const take = chunk.length - (chunk.length % unit)
      leftoverBytes = chunk.subarray(take)
      chunk = chunk.subarray(0, take)
      if (encoding === 'utf8' && chunk.includes(0)) {
        sawNul = true
        break
      }
      const decoded = leftoverText + decodeLineBytes(chunk, encoding)
      const split = splitCompleteLines(decoded)
      leftoverText = split.leftover
      for (const line of split.lines) {
        lineNo += 1
        total = lineNo
        if (lineNo >= start && lineNo <= endLimit) collected.push(line)
      }
    }

    if (sawNul) {
      throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
    }

    if (leftoverBytes.length > 0 && encoding === 'utf8' && leftoverBytes.includes(0)) {
      throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
    }

    if (leftoverText.length > 0 || leftoverBytes.length > 0) {
      const tail =
        leftoverText +
        (leftoverBytes.length > 0 ? decodeLineBytes(leftoverBytes, encoding) : '')
      lineNo += 1
      total = lineNo
      if (lineNo >= start && lineNo <= endLimit) collected.push(tail)
    } else if (total === 0) {
      // Empty file (or BOM-only): one empty line, matching split('\n') on ''.
      total = 1
      if (start === 1 && endLimit >= 1) collected.push('')
    }

    // A trailing newline terminates the last line rather than starting a new one.
    // Streaming already popped the final empty split piece into leftoverText, which
    // we only counted when leftoverText was non-empty — matching split('\n')+pop.

    if (start > total) {
      throw new Error(`startLine ${start} is past the end of ${pathArg} (${total} lines).`)
    }

    const actualEnd = Math.min(endLimit, total)
    return `--- lines ${start}-${actualEnd} of ${total} ---\n` + collected.join('\n')
  } finally {
    closeSync(fd)
  }
}
