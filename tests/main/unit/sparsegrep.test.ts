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
import { toolSearch } from '@main/agent/tools/search'
import { minimalDocx } from './helpers/minimalDocx'

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

  it('matches ^export on a later line through trigram candidates', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-caret-'))
    mkdirSync(join(dir, 'src', 'main', 'agent', 'tools'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'main', 'agent', 'tools', 'webFetch.ts'),
      'import { x } from "./y"\nexport function toolWebFetch() {}\n',
      'utf8'
    )
    await ensureSparseGrepSynced(dir)
    const out = await toolGrep(dir, '^export', {
      include: 'src/main/agent/tools/webFetch.ts',
      maxResults: 15
    })
    expect(out).toContain('src/main/agent/tools/webFetch.ts:2:')
    expect(out).toContain('export function toolWebFetch')
    expect(out).toMatch(/index=trigram/)
    expect(out).not.toMatch(/No matches/)
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

  it('falls back to live walk when trigram prune has no candidates (docx-only hit)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-docx-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const alphaHelper = 1\n', 'utf8')
    writeFileSync(join(dir, 'notes.md.docx'), minimalDocx(['UniqueDocxGrepMarker in architecture']))
    await ensureSparseGrepSynced(dir)
    const out = await toolGrep(dir, 'UniqueDocxGrepMarker', { include: '**/*.docx' })
    expect(out).toContain('UniqueDocxGrepMarker')
    expect(out).toContain('notes.md.docx')
    expect(out).toMatch(/index=live/)

    const withoutInclude = await toolGrep(dir, 'UniqueDocxGrepMarker')
    expect(withoutInclude).toContain('UniqueDocxGrepMarker')
    expect(withoutInclude).toContain('notes.md.docx')
    expect(withoutInclude).toMatch(/index=live/)
  })

  it('still scans docs when trigram already has source candidates', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-docx-overlap-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const SharedDocxGrepMarker = 1\n', 'utf8')
    writeFileSync(join(dir, 'notes.md.docx'), minimalDocx(['SharedDocxGrepMarker in architecture']))
    await ensureSparseGrepSynced(dir)
    const out = await toolGrep(dir, 'SharedDocxGrepMarker')
    expect(out).toContain('src/a.ts')
    expect(out).toContain('notes.md.docx')
    expect(out).toMatch(/index=trigram/)

    const scoped = await toolGrep(dir, 'SharedDocxGrepMarker', { include: '**/*.ts' })
    expect(scoped).toContain('src/a.ts')
    expect(scoped).not.toContain('notes.md.docx')
    expect(scoped).toMatch(/index=trigram/)

    const searchOut = await toolSearch(dir, 'SharedDocxGrepMarker', 10)
    expect(searchOut).toContain('src/a.ts')
    expect(searchOut).toContain('notes.md.docx')
    expect(searchOut).toMatch(/index=trigram/)
  })

  it('still scans tests/ when trigram already has source candidates', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-tests-overlap-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'tests', 'main', 'unit'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'webFetch.ts'),
      'export function fetchPublic() {}\nexport const SharedTestGrepMarkerNot = 1\n',
      'utf8'
    )
    writeFileSync(
      join(dir, 'tests', 'main', 'unit', 'webFetch.test.ts'),
      'import { toolWebFetch } from "@main/agent/tools/webFetch"\nSharedTestGrepMarker\n',
      'utf8'
    )
    await ensureSparseGrepSynced(dir)

    const overlap = await toolGrep(dir, 'SharedTestGrepMarker$')
    expect(overlap).toContain('tests/main/unit/webFetch.test.ts')
    expect(overlap).not.toContain('src/webFetch.ts')
    expect(overlap).toMatch(/index=trigram/)

    const unscoped = await toolGrep(dir, 'toolWebFetch')
    expect(unscoped).toContain('tests/main/unit/webFetch.test.ts')
    expect(unscoped).toContain('toolWebFetch')

    const searchOut = await toolSearch(dir, 'toolWebFetch', 10)
    expect(searchOut).toContain('tests/main/unit/webFetch.test.ts')
  })
})
