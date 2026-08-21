import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  SparseGrepStore,
  closeSparseGrep,
  disposeSparseGrepWorkspace,
  syncSparseGrep,
  extractTrigrams
} from '@main/agent/sparsegrep'

describe('sparsegrep paginated sync', () => {
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

  function buildTree(fileCount: number): string {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-page-'))
    dir = root
    for (let i = 0; i < fileCount; i++) {
      const folder = join(root, `pkg${Math.floor(i / 100)}`)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, `file${i}.ts`), `export const marker${i} = ${i}\n`, 'utf8')
    }
    return root
  }

  it('indexes beyond scan cap across two sync passes without deleting prior batch', async () => {
    const pageCap = 80
    const total = 150
    const root = buildTree(total)
    const store = SparseGrepStore.open(root)

    // Seed an early file so a partial sync must not delete it.
    store.replaceFileTrigrams('pkg0/file0.ts', 'seed', extractTrigrams('seeded early', false))

    const first = await syncSparseGrep(root, store, { pageCap })
    expect(first.partial).toBe(true)
    expect(first.syncComplete).toBe(false)
    expect(first.cursor).toBeTruthy()
    expect(store.getMeta('syncComplete')).toBe('false')
    expect(store.getStatus().fileCount).toBeGreaterThan(0)
    expect(store.listFilePaths()).toContain('pkg0/file0.ts')

    const midCount = store.getStatus().fileCount
    expect(midCount).toBeLessThanOrEqual(pageCap)

    const second = await syncSparseGrep(root, store, { pageCap })
    expect(second.syncComplete).toBe(true)
    expect(store.getMeta('syncComplete')).toBe('true')
    expect(store.getMeta('syncCursor')).toBe('')

    const finalCount = store.getStatus().fileCount
    expect(finalCount).toBeGreaterThan(pageCap)
    expect(finalCount).toBe(total)
    expect(store.listFilePaths()).toContain('pkg0/file0.ts')
    expect(store.listFilePaths()).toContain(`pkg${Math.floor((total - 1) / 100)}/file${total - 1}.ts`)

    store.close()
  }, 60_000)

  it('does not delete indexed files during a partial batch', async () => {
    const pageCap = 80
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-sparse-partial-'))
    dir = root
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'keep.ts'), 'export const keepMe = 1\n', 'utf8')

    for (let i = 0; i < pageCap + 40; i++) {
      const folder = join(root, `bulk${Math.floor(i / 100)}`)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, `f${i}.ts`), `export const x${i} = ${i}\n`, 'utf8')
    }

    const store = SparseGrepStore.open(root)
    store.replaceFileTrigrams('src/keep.ts', 'manual', extractTrigrams('keepMe', false))

    const partial = await syncSparseGrep(root, store, { pageCap })
    expect(partial.partial).toBe(true)
    expect(store.listFilePaths()).toContain('src/keep.ts')

    store.close()
  }, 60_000)
})
