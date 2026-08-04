import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { collectWorkspaceFiles } from '@main/agent/tools/walk'

const canSymlink = (() => {
  if (process.platform === 'win32') return false
  const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-symlink-probe-'))
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

describe('collectWorkspaceFiles', () => {
  it('lists normal files inside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-'))
    try {
      writeFileSync(join(root, 'a.ts'), 'const x = 1', 'utf8')
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'b.ts'), 'export {}', 'utf8')
      const files = await collectWorkspaceFiles(root, 100)
      const rels = files.map((f) => f.rel).sort()
      expect(rels).toEqual(['a.ts', 'src/b.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('skips file symlinks that escape the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-'))
    const outside = mkdtempSync(join(tmpdir(), 'vyotiq-walk-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside-secret', 'utf8')
      writeFileSync(join(root, 'ok.ts'), 'ok', 'utf8')
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file')
      const files = await collectWorkspaceFiles(root, 100)
      expect(files.map((f) => f.rel)).toEqual(['ok.ts'])
      expect(files.every((f) => !f.full.includes('secret'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('skips directory symlinks that escape the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-'))
    const outside = mkdtempSync(join(tmpdir(), 'vyotiq-walk-out-'))
    try {
      writeFileSync(join(outside, 'secret.ts'), 'export const secret = 1', 'utf8')
      writeFileSync(join(root, 'ok.ts'), 'ok', 'utf8')
      symlinkSync(outside, join(root, 'escape'), 'dir')
      const files = await collectWorkspaceFiles(root, 100)
      expect(files.map((f) => f.rel)).toEqual(['ok.ts'])
      expect(files.some((f) => f.rel.includes('secret') || f.rel.includes('escape'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
