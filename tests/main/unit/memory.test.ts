import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureMemoryLayout,
  listMemoryNotes,
  readMemoryFile,
  readMemoryIndex,
  readMemoryState,
  writeMemoryFile,
  memoryRoot
} from '@main/agent/context/memory'
import {
  toolMemoryList,
  toolMemoryRead,
  toolMemoryWrite
} from '@main/agent/tools/memory'

describe('memory store', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('creates layout and writes notes under .vyotiq/memory', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    expect(memoryRoot(dir)).toContain('.vyotiq')
    const written = writeMemoryFile(dir, 'notes/arch.md', '# Arch\n')
    expect(written).toBe('notes/arch.md')
    expect(readMemoryFile(dir, 'notes/arch.md')).toContain('Arch')
    const listed = listMemoryNotes(dir)
    expect(listed.notes).toContain('arch.md')
  })

  it('rejects path escape', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    expect(() => writeMemoryFile(dir, '../secrets.txt', 'nope')).toThrow(/escape|Invalid/)
    expect(() => readMemoryFile(dir, '../secrets.txt')).toThrow(/escape|Invalid/)
    expect(() => readMemoryFile(dir, 'notes/../index.md')).toThrow(/Invalid/)
  })

  it('exposes memory tools', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    toolMemoryWrite(dir, 'notes/prefs.md', 'prefers pnpm')
    expect(toolMemoryRead(dir, 'notes/prefs.md')).toContain('pnpm')
    expect(toolMemoryList(dir)).toContain('prefs.md')
  })

  it('returns friendly response when memory file is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    expect(toolMemoryRead(dir, 'state.md')).toContain('not created yet')
    expect(readMemoryFile(dir, 'state.md')).toContain('not created yet')
    expect(() => toolMemoryRead(dir, 'notes/missing.md')).toThrow(
      'File not found: notes/missing.md'
    )
    // Whitelist validation still wins over missing-file checks
    expect(() => toolMemoryRead(dir, 'other.md')).toThrow(/path must be/)
  })

  it('keeps reads side-effect-free when no memory exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    expect(readMemoryIndex(dir)).toBe('')
    expect(readMemoryState(dir)).toBe('')
    expect(listMemoryNotes(dir)).toEqual({ indexExcerpt: '', notes: [], hasState: false })
    expect(readMemoryFile(dir, 'state.md')).toContain('not created yet')
    expect(existsSync(memoryRoot(dir))).toBe(false)
  })
})
