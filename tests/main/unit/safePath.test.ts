import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  assertResolvedInsideWorkspace,
  resolveInsideWorkspace
} from '@main/workspace/safePath'

const canSymlink = (() => {
  if (process.platform === 'win32') return false
  const root = mkdtempSync(join(tmpdir(), 'vyotiq-symlink-probe-'))
  try {
    const target = join(root, 't.txt')
    writeFileSync(target, 'x', 'utf8')
    symlinkSync(target, join(root, 'link.txt'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})()

describe('resolveInsideWorkspace', () => {
  it('resolves a normal file inside the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-safe-path-'))
    try {
      writeFileSync(join(root, 'note.txt'), 'hello', 'utf8')
      const resolved = resolveInsideWorkspace(root, 'note.txt')
      expect(resolved).toContain('note.txt')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('rejects symlink targets outside the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-safe-path-'))
    const outside = mkdtempSync(join(tmpdir(), 'vyotiq-outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf8')
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file')
      expect(() => resolveInsideWorkspace(root, 'link.txt')).toThrow(/escapes workspace/)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)(
    'rejects new paths under a symlinked parent that escapes the workspace',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'vyotiq-safe-path-'))
      const outside = mkdtempSync(join(tmpdir(), 'vyotiq-outside-'))
      try {
        mkdirSync(join(root, 'nested'))
        symlinkSync(outside, join(root, 'nested', 'escape'), 'dir')
        expect(() => resolveInsideWorkspace(root, 'nested/escape/new.txt')).toThrow(
          /escapes workspace/
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    }
  )
})

describe('assertResolvedInsideWorkspace', () => {
  it('accepts paths under the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-safe-path-'))
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      expect(() => assertResolvedInsideWorkspace(root, join(root, 'src'))).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('rejects after a parent is swapped for an escaping symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-safe-path-'))
    const outside = mkdtempSync(join(tmpdir(), 'vyotiq-outside-'))
    try {
      mkdirSync(join(root, 'nested'), { recursive: true })
      const nested = join(root, 'nested')
      rmSync(nested, { recursive: true, force: true })
      symlinkSync(outside, nested, 'dir')
      expect(() => assertResolvedInsideWorkspace(root, join(nested, 'new.txt'))).toThrow(
        /escapes workspace/
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
