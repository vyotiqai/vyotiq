import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CodeIndexStore } from '@main/agent/codeindex/store'
import { createLocalHashEmbedder } from '@main/agent/codeindex/embed'
import { INDEX_SCAN_CAP, syncCodeIndex } from '@main/agent/codeindex/sync'

describe('codeindex paginated sync', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      dir = undefined
    }
  })

  function buildTree(fileCount: number): string {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-code-page-'))
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
    const store = CodeIndexStore.open(root, 32)
    const embedder = createLocalHashEmbedder(32)

    store.replaceFileChunks('pkg0/file0.ts', 'seed', Date.now(), [
      {
        startLine: 1,
        endLine: 1,
        kind: 'module',
        name: 'seed',
        chunkHash: 'seed',
        embedding: new Float32Array(32),
        ftsText: 'seeded early'
      }
    ])

    const first = await syncCodeIndex(root, store, embedder, { pageCap })
    expect(first.partial).toBe(true)
    expect(first.syncComplete).toBe(false)
    expect(first.cursor).toBeTruthy()
    expect(store.getMeta('syncComplete')).toBe('false')
    expect(store.getStatus().fileCount).toBeGreaterThan(0)
    expect(store.listFilePaths()).toContain('pkg0/file0.ts')

    const midCount = store.getStatus().fileCount
    expect(midCount).toBeLessThanOrEqual(pageCap)

    const second = await syncCodeIndex(root, store, embedder, { pageCap })
    expect(second.syncComplete).toBe(true)
    expect(store.getMeta('syncComplete')).toBe('true')
    expect(store.getMeta('syncCursor')).toBe('')

    const finalCount = store.getStatus().fileCount
    expect(finalCount).toBeGreaterThan(pageCap)
    expect(finalCount).toBe(total)
    expect(store.listFilePaths()).toContain('pkg0/file0.ts')
    expect(store.listFilePaths()).toContain(`pkg${Math.floor((total - 1) / 100)}/file${total - 1}.ts`)
    expect(INDEX_SCAN_CAP).toBe(8000)

    store.close()
  }, 60_000)

  it('does not delete indexed files during a partial batch', async () => {
    const pageCap = 80
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-code-partial-'))
    dir = root
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'keep.ts'), 'export const keepMe = 1\n', 'utf8')

    for (let i = 0; i < pageCap + 40; i++) {
      const folder = join(root, `bulk${Math.floor(i / 100)}`)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(root, `bulk${Math.floor(i / 100)}`, `f${i}.ts`), `export const x${i} = ${i}\n`, 'utf8')
    }

    const store = CodeIndexStore.open(root, 32)
    const embedder = createLocalHashEmbedder(32)
    store.replaceFileChunks('src/keep.ts', 'manual', Date.now(), [
      {
        startLine: 1,
        endLine: 1,
        kind: 'module',
        name: 'keep',
        chunkHash: 'manual',
        embedding: new Float32Array(32),
        ftsText: 'keepMe'
      }
    ])

    const partial = await syncCodeIndex(root, store, embedder, { pageCap })
    expect(partial.partial).toBe(true)
    expect(store.listFilePaths()).toContain('src/keep.ts')

    store.close()
  }, 60_000)
})
