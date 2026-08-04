import {
  listMemoryNotes,
  readMemoryFile,
  writeMemoryFile
} from '../context/memory'

export function toolMemoryList(workspace: string): string {
  const { indexExcerpt, notes, hasState } = listMemoryNotes(workspace)
  return [
    '## index.md (excerpt)',
    indexExcerpt || '(empty)',
    '',
    '## notes/',
    notes.length ? notes.map((n) => `- ${n}`).join('\n') : '(none)',
    '',
    `state.md: ${hasState ? 'present' : 'absent'}`
  ].join('\n')
}

export function toolMemoryRead(workspace: string, pathArg: string): string {
  const cleaned = pathArg.trim().replace(/^[/\\]+/, '')
  if (!cleaned) throw new Error('path is required')
  // Allow index.md, state.md, notes/foo.md
  if (
    cleaned !== 'index.md' &&
    cleaned !== 'state.md' &&
    !cleaned.startsWith('notes/')
  ) {
    throw new Error('path must be index.md, state.md, or notes/<name>.md')
  }
  return readMemoryFile(workspace, cleaned)
}

/** Max characters accepted by memory_write. */
export const MEMORY_WRITE_CAP = 64 * 1024

export function toolMemoryWrite(
  workspace: string,
  pathArg: string,
  contents: string
): string {
  const cleaned = pathArg.trim().replace(/^[/\\]+/, '')
  if (!cleaned) throw new Error('path is required')
  if (cleaned.includes('..')) throw new Error('Invalid memory path')
  if (
    cleaned !== 'index.md' &&
    cleaned !== 'state.md' &&
    !cleaned.startsWith('notes/')
  ) {
    throw new Error('path must be index.md, state.md, or notes/<name>.md')
  }
  if (cleaned.startsWith('notes/')) {
    const noteName = cleaned.slice('notes/'.length)
    if (!noteName || !/^[a-zA-Z0-9._-]+\.md$/.test(noteName)) {
      throw new Error('note files must be notes/<name>.md with safe characters')
    }
  }
  if (contents.length > MEMORY_WRITE_CAP) {
    throw new Error(`Memory write too large (${contents.length} chars). Cap is ${MEMORY_WRITE_CAP}.`)
  }
  const written = writeMemoryFile(workspace, cleaned, contents)
  return `Wrote memory/${written}`
}
