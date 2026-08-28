import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const querySparseFileList = vi.fn()

vi.mock('@main/agent/sparsegrep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/sparsegrep')>()
  return {
    ...actual,
    querySparseFileList: (...args: unknown[]) => querySparseFileList(...args)
  }
})

import { globPatternIsTextOnly, nestedGlobPattern, toolGlob } from '@main/agent/tools/glob'
import { SPARSE_GREP_SCAN_CAP } from '@main/agent/sparsegrep'

describe('glob sparsegrep index path', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-glob-index-'))
    mkdirSync(root, { recursive: true })
    querySparseFileList.mockReset()
  })

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('uses trigram index file list when ready', async () => {
    querySparseFileList.mockResolvedValue({
      ready: true,
      paths: ['src/a.ts', 'src/b.ts', 'docs/readme.md'],
      fileCount: 3,
      syncComplete: true
    })
    const out = await toolGlob(root, '**/*.ts')
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/b.ts')
    expect(out).not.toContain('readme.md')
    expect(out).toMatch(/index=trigram/)
    expect(out).not.toMatch(/scan cap/i)
    expect(out).not.toMatch(/sync in progress/i)
  })

  it('falls back to live walk when sync is incomplete', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    const { writeFileSync } = await import('fs')
    writeFileSync(join(root, 'src', 'live-only.ts'), 'export const x = 1\n', 'utf8')
    querySparseFileList.mockResolvedValue({
      ready: true,
      paths: [],
      fileCount: SPARSE_GREP_SCAN_CAP,
      syncComplete: false
    })
    const out = await toolGlob(root, '**/*.ts')
    expect(out).toContain('src/live-only.ts')
    expect(out).toMatch(/index sync in progress \(20000 files indexed so far\)/)
    expect(out).toMatch(/index=live/)
  })

  it('omits incomplete notice when syncComplete is true even at scan cap', async () => {
    querySparseFileList.mockResolvedValue({
      ready: true,
      paths: ['a.ts'],
      fileCount: SPARSE_GREP_SCAN_CAP + 500,
      syncComplete: true
    })
    const out = await toolGlob(root, '**/*.ts')
    expect(out).not.toMatch(/sync in progress/i)
    expect(out).not.toMatch(/sync cap/i)
    expect(out).toMatch(/index=trigram/)
  })

  it('live-walks non-text globs even when the sparse list is ready', async () => {
    const { writeFileSync } = await import('fs')
    writeFileSync(join(root, 'icon.png'), 'png', 'utf8')
    querySparseFileList.mockResolvedValue({
      ready: true,
      paths: ['src/a.ts'],
      fileCount: 1,
      syncComplete: true
    })
    const out = await toolGlob(root, '**/*.png')
    expect(out).toContain('icon.png')
    expect(out).toMatch(/index=live/)
  })

  it('lists nested matches when a source glob omits the nested folder prefix', async () => {
    querySparseFileList.mockResolvedValue({
      ready: true,
      paths: ['project/src/a.ts'],
      fileCount: 1,
      syncComplete: true
    })
    const out = await toolGlob(root, 'src/**/*.ts')
    expect(out).toContain('No files match src/**/*.ts')
    expect(out).toContain('Nested matches:')
    expect(out).toContain('project/src/a.ts')
    expect(out).toMatch(/index=trigram/)
  })
})

describe('nestedGlobPattern', () => {
  it('prepends **/ unless the glob is already recursive from the root', () => {
    expect(nestedGlobPattern('windows/**/*.{sln,slnf,csproj}')).toBe(
      '**/windows/**/*.{sln,slnf,csproj}'
    )
    expect(nestedGlobPattern('./src/**/*.ts')).toBe('**/src/**/*.ts')
    expect(nestedGlobPattern('**/*.ts')).toBeNull()
    expect(nestedGlobPattern('')).toBeNull()
  })
})

describe('globPatternIsTextOnly', () => {
  it('accepts source globs and rejects binaries and bare stars', () => {
    expect(globPatternIsTextOnly('**/*.ts')).toBe(true)
    expect(globPatternIsTextOnly('**/*.{ts,tsx}')).toBe(true)
    expect(globPatternIsTextOnly('**/*.png')).toBe(false)
    expect(globPatternIsTextOnly('**/*.md')).toBe(false)
    expect(globPatternIsTextOnly('**/*.json')).toBe(false)
    expect(globPatternIsTextOnly('**/*.sql')).toBe(false)
    expect(globPatternIsTextOnly('**/*')).toBe(false)
    expect(globPatternIsTextOnly('Dockerfile')).toBe(false)
  })
})
