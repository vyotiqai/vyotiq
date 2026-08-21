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
  if (cleaned.includes('..')) throw new Error('Invalid memory path')
  // Allow index.md, state.md, notes/foo.md
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
  return readMemoryFile(workspace, cleaned)
}

/** @deprecated Kept for callers that still import the former write cap. */
export const MEMORY_WRITE_CAP = Number.POSITIVE_INFINITY

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
  const written = writeMemoryFile(workspace, cleaned, contents)
  return `Wrote memory/${written}`
}
