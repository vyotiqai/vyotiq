import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join, relative, resolve, sep } from 'path'
import { MEMORY_INDEX_CAP, MEMORY_STATE_CAP } from './types'

export function memoryRoot(workspacePath: string): string {
  return join(workspacePath, '.vyotiq', 'memory')
}

export function ensureMemoryLayout(workspacePath: string): void {
  const root = memoryRoot(workspacePath)
  const notes = join(root, 'notes')
  if (!existsSync(notes)) mkdirSync(notes, { recursive: true })
  const indexPath = join(root, 'index.md')
  if (!existsSync(indexPath)) {
    writeFileSync(
      indexPath,
      '# Memory index\n\nShort pointers to durable notes. Keep this file brief.\n',
      'utf8'
    )
  }
}

function assertUnderMemory(workspacePath: string, targetPath: string): string {
  const rootResolved = resolve(memoryRoot(workspacePath))
  const realRoot = existsSync(rootResolved) ? realpathSync(rootResolved) : rootResolved
  const candidate = resolve(realRoot, targetPath)
  const checkContained = (resolved: string): void => {
    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep
    const equal =
      process.platform === 'win32'
        ? resolved.toLowerCase() === realRoot.toLowerCase()
        : resolved === realRoot
    const inside =
      process.platform === 'win32'
        ? resolved.toLowerCase().startsWith(prefix.toLowerCase())
        : resolved.startsWith(prefix)
    if (!equal && !inside) {
      throw new Error(`Path escapes memory dir: ${targetPath}`)
    }
  }
  checkContained(candidate)
  if (existsSync(candidate)) {
    const real = realpathSync(candidate)
    checkContained(real)
    return real
  }
  return candidate
}

function readMemoryFileExcerpt(
  workspacePath: string,
  relPath: string,
  cap: number
): string {
  const p = join(memoryRoot(workspacePath), relPath)
  if (!existsSync(p)) return ''
  try {
    const text = readFileSync(p, 'utf8')
    return text.length > cap ? text.slice(0, cap) + '\n…' : text
  } catch {
    return ''
  }
}

async function readMemoryFileExcerptAsync(
  workspacePath: string,
  relPath: string,
  cap: number
): Promise<string> {
  const p = join(memoryRoot(workspacePath), relPath)
  if (!existsSync(p)) return ''
  try {
    const text = await readFile(p, 'utf8')
    return text.length > cap ? text.slice(0, cap) + '\n…' : text
  } catch {
    return ''
  }
}

export function readMemoryIndex(workspacePath: string, cap = MEMORY_INDEX_CAP): string {
  return readMemoryFileExcerpt(workspacePath, 'index.md', cap)
}

export async function readMemoryIndexAsync(
  workspacePath: string,
  cap = MEMORY_INDEX_CAP
): Promise<string> {
  return readMemoryFileExcerptAsync(workspacePath, 'index.md', cap)
}

export function readMemoryState(workspacePath: string, cap = MEMORY_STATE_CAP): string {
  return readMemoryFileExcerpt(workspacePath, 'state.md', cap)
}

export async function readMemoryStateAsync(
  workspacePath: string,
  cap = MEMORY_STATE_CAP
): Promise<string> {
  return readMemoryFileExcerptAsync(workspacePath, 'state.md', cap)
}

export const MEMORY_LIST_INDEX_EXCERPT = 1500

export function listMemoryNotes(workspacePath: string): {
  indexExcerpt: string
  notes: string[]
  hasState: boolean
} {
  const root = memoryRoot(workspacePath)
  const notesDir = join(root, 'notes')
  let notes: string[] = []
  try {
    notes = readdirSync(notesDir)
      .filter((n) => n.endsWith('.md'))
      .sort()
  } catch {
    notes = []
  }
  return {
    indexExcerpt: readMemoryIndex(workspacePath, MEMORY_LIST_INDEX_EXCERPT),
    notes,
    hasState: existsSync(join(root, 'state.md'))
  }
}

export function readMemoryFile(workspacePath: string, relPath: string): string {
  const cleaned = relPath.replace(/^[/\\]+/, '')
  if (cleaned.includes('..')) throw new Error('Invalid memory path')
  const resolved = assertUnderMemory(workspacePath, cleaned)
  if (!existsSync(resolved)) {
    if (cleaned === 'state.md') {
      return '(state.md not created yet — use memory_write to create it)'
    }
    throw new Error(`File not found: ${cleaned}`)
  }
  return readFileSync(resolved, 'utf8')
}

export function writeMemoryFile(
  workspacePath: string,
  relPath: string,
  contents: string
): string {
  ensureMemoryLayout(workspacePath)
  const cleaned = relPath.replace(/^[/\\]+/, '')
  if (cleaned.includes('..')) throw new Error('Invalid memory path')
  const resolved = assertUnderMemory(workspacePath, cleaned)
  mkdirSync(dirname(resolved), { recursive: true })
  writeFileSync(resolved, contents, 'utf8')
  return relative(memoryRoot(workspacePath), resolved).replace(/\\/g, '/')
}
