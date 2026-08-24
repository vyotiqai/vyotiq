import { describe, expect, it } from 'vitest'
import {
  buildOrtSessionOptions,
  resolveOrtIntraOpThreads
} from '@main/agent/codeindex/ortSessionOptions'
import { lowerProcessPriority } from '@main/agent/processPriority'
import { RECONCILE_WALK_CAP, SPARSE_GREP_SCAN_CAP } from '@main/agent/sparsegrep/sync'
import { CODE_INDEX_RECONCILE_WALK_CAP, INDEX_SCAN_CAP } from '@main/agent/codeindex/sync'
import { insertTopK, streamDenseTopK } from '@main/agent/codeindex/search'
import { CodeIndexStore } from '@main/agent/codeindex/store'
import { createLocalHashEmbedder, cosineSimilarity } from '@main/agent/codeindex/embed'
import {
  canUseIndexSearchUtility,
  canUseIndexSyncUtility
} from '@main/agent/codeindex/embedUtilityClient'

describe('ortSessionOptions', () => {
  it('in-process intra-op stays at 1 even when env asks for more', () => {
    expect(resolveOrtIntraOpThreads(undefined)).toBe(1)
    expect(resolveOrtIntraOpThreads('')).toBe(1)
    expect(resolveOrtIntraOpThreads('0')).toBe(1)
    expect(resolveOrtIntraOpThreads('2')).toBe(1)
    expect(resolveOrtIntraOpThreads('8')).toBe(1)
    expect(resolveOrtIntraOpThreads('1.9', 'in-process')).toBe(1)
  })

  it('utility intra-op defaults to 4 and clamps env to 1–8', () => {
    expect(resolveOrtIntraOpThreads(undefined, 'utility', 8)).toBe(4)
    expect(resolveOrtIntraOpThreads(undefined, 'utility', 2)).toBe(4)
    expect(resolveOrtIntraOpThreads('3', 'utility', 16)).toBe(3)
    expect(resolveOrtIntraOpThreads('8', 'utility', 16)).toBe(8)
    expect(resolveOrtIntraOpThreads('99', 'utility', 16)).toBe(8)
    expect(resolveOrtIntraOpThreads('0', 'utility', 8)).toBe(4)
  })

  it('builds sequential session options with spinning and mem-pattern disabled', () => {
    const opts = buildOrtSessionOptions('2', 'utility')
    expect(opts.intraOpNumThreads).toBe(2)
    expect(opts.interOpNumThreads).toBe(1)
    expect(opts.executionMode).toBe('sequential')
    expect(opts.enableCpuMemArena).toBe(false)
    expect(opts.enableMemPattern).toBe(false)
    expect(opts['session.intra_op.allow_spinning']).toBe('0')
    expect(buildOrtSessionOptions('8').intraOpNumThreads).toBe(1)
  })
})

describe('processPriority', () => {
  it('lowerProcessPriority is best-effort and does not throw', () => {
    expect(() => lowerProcessPriority(process.pid)).not.toThrow()
    expect(lowerProcessPriority(-1)).toBe(false)
    expect(lowerProcessPriority(0)).toBe(false)
  })
})

describe('sparsegrep RECONCILE_WALK_CAP', () => {
  it('is finite and at least 2× scan cap', () => {
    expect(Number.isFinite(RECONCILE_WALK_CAP)).toBe(true)
    expect(RECONCILE_WALK_CAP).toBeLessThan(Number.MAX_SAFE_INTEGER)
    expect(RECONCILE_WALK_CAP).toBeGreaterThanOrEqual(SPARSE_GREP_SCAN_CAP * 2)
  })
})

describe('codeindex RECONCILE_WALK_CAP', () => {
  it('is finite and at least 2× scan cap', () => {
    expect(INDEX_SCAN_CAP).toBe(24000)
    expect(Number.isFinite(CODE_INDEX_RECONCILE_WALK_CAP)).toBe(true)
    expect(CODE_INDEX_RECONCILE_WALK_CAP).toBeGreaterThanOrEqual(INDEX_SCAN_CAP * 2)
  })
})

describe('streaming dense top-k', () => {
  it('insertTopK keeps highest scores', () => {
    const top: { id: number; score: number }[] = []
    insertTopK(top, 1, 0.1, 3)
    insertTopK(top, 2, 0.9, 3)
    insertTopK(top, 3, 0.5, 3)
    insertTopK(top, 4, 0.2, 3)
    insertTopK(top, 5, 0.8, 3)
    expect(top.map((t) => t.id)).toEqual([2, 5, 3])
  })

  it('streamDenseTopK matches full-scan ranking for small fixtures', async () => {
    const dim = 8
    const store = CodeIndexStore.openMemory(dim)
    const embedder = createLocalHashEmbedder(dim)
    try {
      const texts = ['alpha auth token', 'billing refund', 'unrelated zebra']
      const vecs = await embedder.embed(texts, { role: 'document' })
      for (let i = 0; i < texts.length; i++) {
        store.replaceFileChunks(
          `f${i}.ts`,
          `hash-${i}`,
          Date.now(),
          [
            {
              startLine: 1,
              endLine: 1,
              kind: 'function',
              name: `n${i}`,
              parentName: undefined,
              chunkHash: `ch-${i}`,
              embedding: vecs[i]!,
              ftsText: texts[i]!
            }
          ]
        )
      }

      const [q] = await embedder.embed(['auth token'], { role: 'query' })
      const streamed = await streamDenseTopK(store, q!, 2)
      const all = store.loadAllEmbeddings()
      const full = all
        .map((row) => ({ id: row.id, score: cosineSimilarity(q!, row.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)

      expect(streamed.map((s) => s.id)).toEqual(full.map((s) => s.id))
      expect(streamed.map((s) => s.score)).toEqual(full.map((s) => s.score))
    } finally {
      store.close()
    }
  })
})

describe('index utility gate (Vitest)', () => {
  it('forces in-process under Vitest — no silent production utility fallback path', () => {
    expect(canUseIndexSyncUtility()).toBe(false)
    expect(canUseIndexSearchUtility()).toBe(false)
  })
})

describe('utility cancel set', () => {
  it('consume returns true only for remembered ids', async () => {
    const { createCancelledIdSet } = await import('@main/agent/codeindex/utilityCancel')
    const set = createCancelledIdSet(3)
    set.remember(10)
    set.remember(11)
    expect(set.consume(10)).toBe(true)
    expect(set.consume(10)).toBe(false)
    expect(set.has(11)).toBe(true)
    set.remember(12)
    set.remember(13)
    set.remember(14)
    // Bounded — oldest dropped when over max
    expect(set.size()).toBeLessThanOrEqual(3)
  })
})

describe('ollama utility opts', () => {
  it('fills baseUrl and model from settings when opts omit them', async () => {
    const { buildOllamaUtilityOptsForTests, createOllamaEmbedder } = await import(
      '@main/agent/codeindex'
    )
    const embedder = createOllamaEmbedder({
      baseUrl: 'http://custom:11434',
      model: 'custom-embed',
      dimensions: 768
    })
    // Pass no ollama override — helper should still resolve from embedder modelId + settings defaults.
    const opts = buildOllamaUtilityOptsForTests(embedder)
    expect(opts).toBeDefined()
    expect(opts!.model).toBe('custom-embed')
    expect(opts!.baseUrl.length).toBeGreaterThan(0)
    expect(opts!.dimensions).toBe(768)

    const overridden = buildOllamaUtilityOptsForTests(embedder, {
      baseUrl: 'http://override:9',
      model: 'other'
    })
    expect(overridden).toEqual({
      baseUrl: 'http://override:9',
      model: 'other',
      dimensions: 768
    })
  })
})

describe('index sync progress', () => {
  it('publishes live counters into runtime status', async () => {
    const { publishIndexSyncProgress } = await import('@main/agent/codeindex/indexProgress')
    const {
      getCodeIndexRuntimeStatus,
      resetCodeIndexRuntimeStatusForTests
    } = await import('@main/agent/codeindex/modelStatus')
    resetCodeIndexRuntimeStatusForTests()
    publishIndexSyncProgress(
      {
        kind: 'code',
        stage: 'embedding',
        filesDone: 3,
        filesTotal: 10,
        indexed: 1,
        skipped: 2,
        embedChunks: 4,
        currentPath: 'src/a.ts'
      },
      { force: true }
    )
    const st = getCodeIndexRuntimeStatus()
    expect(st.phase).toBe('indexing')
    expect(st.indexProgress?.filesDone).toBe(3)
    expect(st.indexProgress?.embedChunks).toBe(4)
    expect(st.indexProgress?.currentPath).toBe('src/a.ts')
    expect(st.progress).toBeCloseTo(0.3, 5)
    expect(st.message).toMatch(/Embedding/i)
    resetCodeIndexRuntimeStatusForTests()
  })

  it('syncCodeIndex accepts a precollected walk without changing skip semantics', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { syncCodeIndex, INDEX_SCAN_CAP } = await import('@main/agent/codeindex/sync')
    const { CodeIndexStore } = await import('@main/agent/codeindex/store')
    const { createLocalHashEmbedder } = await import('@main/agent/codeindex/embed')
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-sync-progress-'))
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1\n', 'utf8')
      writeFileSync(join(root, 'b.ts'), 'export const b = 2\n', 'utf8')
      const store = CodeIndexStore.open(root, 32)
      const embedder = createLocalHashEmbedder(32)
      const files = [
        { full: join(root, 'a.ts'), rel: 'a.ts' },
        { full: join(root, 'b.ts'), rel: 'b.ts' }
      ]
      const first = await syncCodeIndex(root, store, embedder, { files })
      expect(first.indexed).toBe(2)
      expect(INDEX_SCAN_CAP).toBe(24000)
      const second = await syncCodeIndex(root, store, embedder, { files })
      expect(second.indexed).toBe(0)
      expect(second.skipped).toBe(2)
      const third = await syncCodeIndex(root, store, embedder, { files })
      expect(third.indexed).toBe(0)
      expect(third.skipped).toBe(2)
      store.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
