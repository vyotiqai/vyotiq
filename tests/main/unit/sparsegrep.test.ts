import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractTrigrams,
  requiredTrigramsForPattern,
  requiredTrigramsForSubstring,
  SparseGrepStore,
  syncSparseGrep,
  closeSparseGrep,
  disposeSparseGrepWorkspace,
  ensureSparseGrepSynced,
  lookupCandidatesForRegex
} from '@main/agent/sparsegrep'
import { toolGrep } from '@main/agent/tools/grep'

describe('trigram extract', () => {
  it('extracts overlapping lowercase trigrams', () => {
    const g = extractTrigrams('abcd', false)
    expect([...g].sort()).toEqual(['abc', 'bcd'])
  })

  it('returns null for unusable regex patterns', () => {
    expect(requiredTrigramsForPattern('.*', false)).toBeNull()
    expect(requiredTrigramsForPattern('a|b', false)).toBeNull()
    expect(requiredTrigramsForPattern('.', false)).toBeNull()
  })

  it('extracts grams from identifier literals', () => {
    const g = requiredTrigramsForPattern('validateAuthToken', false)
    expect(g).not.toBeNull()
    expect(g!.has('val')).toBe(true)
    expect(g!.has('ken')).toBe(true)
  })

  it('requires length >= 3 for substrings', () => {
    expect(requiredTrigramsForSubstring('ab', false)).toBeNull()
    expect(requiredTrigramsForSubstring('abc', false)?.has('abc')).toBe(true)
  })
})

describe('sparsegrep sync + grep parity', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) {
      disposeSparseGrepWorkspace(dir)
      closeSparseGrep(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      dir = undefined
    }
  })

  it('indexes incrementally and greps match live scan', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const alphaHelper = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const betaOther = 2\n', 'utf8')

    const { store, sync } = await ensureSparseGrepSynced(dir)
    expect(sync?.indexed).toBeGreaterThan(0)
    expect(store.getStatus().ready).toBe(true)

    const live = await toolGrep(dir, 'alphaHelper')
    // Force live by closing store so next open is empty? Better: compare hit lines
    // After sync, grep should use trigram path
    expect(live).toContain('src/a.ts:1')
    expect(live).toContain('index=trigram')
    expect(live).not.toContain('src/b.ts')

    const again = await ensureSparseGrepSynced(dir)
    expect(again.sync?.indexed).toBe(0)
    expect(again.sync?.skipped).toBeGreaterThan(0)

    // Unsafe pattern falls back to live
    const wild = await toolGrep(dir, '.*')
    expect(wild).toMatch(/index=live/)
  })

  it('skips unchanged files on second sync', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse2-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'const uniqueMarkerXYZ = 1\n', 'utf8')
    const store = SparseGrepStore.open(dir)
    const first = await syncSparseGrep(dir, store)
    expect(first.indexed).toBe(1)
    const second = await syncSparseGrep(dir, store)
    expect(second.skipped).toBe(1)
    expect(second.indexed).toBe(0)
    store.close()
  })

  it('drops oversized files from the sparse index', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-oversize-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    const grow = join(dir, 'src', 'grow.ts')
    writeFileSync(grow, 'export const sparseGrow = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'keep.ts'), 'export const sparseKeep = 1\n', 'utf8')
    const store = SparseGrepStore.open(dir)
    try {
      await syncSparseGrep(dir, store)
      expect(store.listFilePaths().sort()).toEqual(['src/grow.ts', 'src/keep.ts'])
      writeFileSync(grow, Buffer.alloc(513 * 1024, 97))
      const second = await syncSparseGrep(dir, store)
      expect(store.listFilePaths()).toEqual(['src/keep.ts'])
      expect(second.removed).toBe(1)
    } finally {
      store.close()
    }
  })

  it('keeps previously indexed files that become unreadable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-unreadable-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'keep.ts'), 'export const sparseKeep = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'lock.ts'), 'export const sparseLock = 1\n', 'utf8')
    const store = SparseGrepStore.open(dir)
    try {
      await syncSparseGrep(dir, store)
      expect(store.listFilePaths().sort()).toEqual(['src/keep.ts', 'src/lock.ts'])
      rmSync(join(dir, 'src', 'lock.ts'))
      mkdirSync(join(dir, 'src', 'lock.ts'))
      await syncSparseGrep(dir, store, {
        files: [
          { rel: 'src/keep.ts', full: join(dir, 'src', 'keep.ts') },
          { rel: 'src/lock.ts', full: join(dir, 'src', 'lock.ts') }
        ]
      })
      expect(store.listFilePaths().sort()).toEqual(['src/keep.ts', 'src/lock.ts'])
    } finally {
      store.close()
    }
  })

  it('does not delete files outside a capped precollect', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-cap-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'keep.ts'), 'export const keepOutside = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'page.ts'), 'export const pageOnly = 1\n', 'utf8')
    const store = SparseGrepStore.open(dir)
    try {
      await syncSparseGrep(dir, store)
      expect(store.listFilePaths()).toEqual(expect.arrayContaining(['src/keep.ts', 'src/page.ts']))
      const pageOnly = [
        { full: join(dir, 'src', 'page.ts'), rel: 'src/page.ts' }
      ]
      const second = await syncSparseGrep(dir, store, { files: pageOnly, pageCap: 1 })
      expect(second.syncComplete).toBe(false)
      expect(store.listFilePaths()).toContain('src/keep.ts')
      expect(store.listFilePaths()).toContain('src/page.ts')
    } finally {
      store.close()
    }
  })

  it('drops NUL/binary files from the sparse index', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-nul-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'keep.ts'), 'export const sparseKeep = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'bin.ts'), Buffer.from([0x66, 0x00, 0x6e]))
    const store = SparseGrepStore.open(dir)
    try {
      await syncSparseGrep(dir, store)
      expect(store.listFilePaths()).toEqual(['src/keep.ts'])
    } finally {
      store.close()
    }
  })

  it('drops tests, lockfiles, and minified dumps', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-clutter-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'keep.ts'), 'export const sparseKeep = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'keep.test.ts'), 'export const sparseTest = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'vendor.min.js'), 'export const min = 1\n', 'utf8')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
    const store = SparseGrepStore.open(dir)
    try {
      await syncSparseGrep(dir, store)
      expect(store.listFilePaths()).toEqual(['src/keep.ts'])
    } finally {
      store.close()
    }
  })

  it('candidate lookup finds file with required grams', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse3-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'auth.ts'), 'function validateAuthToken() {}\n', 'utf8')
    const { store: s } = await ensureSparseGrepSynced(dir)
    const lookup = lookupCandidatesForRegex(s, 'validateAuthToken', false)
    expect(lookup.ok).toBe(true)
    if (lookup.ok) {
      expect(lookup.paths).toContain('src/auth.ts')
    }
  })
})
