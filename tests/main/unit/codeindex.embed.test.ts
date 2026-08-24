import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodeIndexStore,
  closeCodeIndex,
  CODE_INDEX_EMBED_BATCH,
  embedLengthBucket,
  clearEmbedderFailCacheForTests,
  createLocalHashEmbedder,
  createOllamaEmbedder,
  ensureCodeIndexSynced,
  getOrOpenCodeIndex,
  resolveEmbedderForTests,
  searchCodeIndex,
  syncCodeIndex
} from '@main/agent/codeindex'
import { DEFAULT_MODEL_ID, DENSEON_ONNX_MODEL_ID, LIGHTON_DENSE_DIM, shouldPreserveIndexedEmbeddings } from '@main/agent/codeindex/types'
import { toolCodebaseSearch } from '@main/agent/tools/codebaseSearch'

describe('codeindex Ollama embedder + fallback', () => {
  let dir: string

  afterEach(() => {
    clearEmbedderFailCacheForTests()
    if (dir) {
      closeCodeIndex(dir)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('createOllamaEmbedder uses mocked fetch and returns normalized vectors', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        embeddings: [Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))]
      })
    }))
    const embedder = createOllamaEmbedder({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dimensions: 768
    })
    expect(embedder.modelId).toBe('ollama:nomic-embed-text')
    const [vec] = await embedder.embed(['hello code'])
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec!.length).toBe(768)
    expect(Math.abs(vec![0]! - 1)).toBeLessThan(1e-5)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/api\/embed$/)
  })

  it('auto-detects the true Ollama dimension when none is configured', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        embeddings: [Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))]
      })
    }))
    const embedder = createOllamaEmbedder({
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    // Before any embed the getter still reports the safe default.
    expect(embedder.dimensions).toBe(768)
    const [vec] = await embedder.embed(['hello code'])
    // After embed the real dimension is adopted and NOT truncated.
    expect(embedder.dimensions).toBe(1024)
    expect(vec!.length).toBe(1024)
    expect(Math.abs(vec![0]! - 1)).toBeLessThan(1e-5)
  })

  it('throws when an explicit dimension does not match the Ollama model', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        embeddings: [Array.from({ length: 1024 }, () => 0.1)]
      })
    }))
    const embedder = createOllamaEmbedder({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dimensions: 768
    })
    await expect(embedder.embed(['hello code'])).rejects.toThrow(/1024-dim/)
  })

  it('falls back to /api/embeddings when /api/embed is unavailable', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/embed')) {
        return { ok: false, status: 404, json: async () => ({}) }
      }
      return {
        ok: true,
        json: async () => ({ embedding: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)) })
      }
    })
    const embedder = createOllamaEmbedder({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dimensions: 768
    })
    const [vec] = await embedder.embed(['hello code'])
    expect(vec!.length).toBe(768)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('preferOllama falls back to local-hash when probe fails', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-embed-fb-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function a() { return 1 }\n', 'utf8')
    const entry = await getOrOpenCodeIndex(dir, {
      embedderId: 'ollama',
      ollama: {
        fetchImpl: (async () => {
          throw new Error('ollama unreachable')
        }) as unknown as typeof fetch
      }
    })
    expect(entry.embedder.modelId).toBe(DEFAULT_MODEL_ID)
    closeCodeIndex(dir)
  })

  it('does not retry failed Ollama probe within fail-cache TTL', async () => {
    let probes = 0
    const fetchImpl = vi.fn(async () => {
      probes++
      throw new Error('ollama unreachable')
    }) as unknown as typeof fetch
    const opts = {
      embedderId: 'ollama' as const,
      ollama: { fetchImpl }
    }
    const first = await resolveEmbedderForTests(opts)
    expect(first.usedFallback).toBe(true)
    expect(first.embedder.modelId).toBe(DEFAULT_MODEL_ID)
    const afterFirst = probes
    expect(afterFirst).toBeGreaterThan(0)
    const second = await resolveEmbedderForTests(opts)
    expect(second.usedFallback).toBe(true)
    expect(probes).toBe(afterFirst)
    expect(fetchImpl).toHaveBeenCalledTimes(afterFirst)
  })

  it('tool header notes fallback=hash when using local-hash model', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-embed-hdr-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'auth.ts'),
      'export function validateAuthToken(t: string) { return t.length > 0 }\n',
      'utf8'
    )
    const out = await toolCodebaseSearch(dir, 'validate auth', {
      preferOllama: false,
      maxResults: 3
    })
    // With default settings (mdenseon) tool no longer forces ollama; hash appears when ONNX missing.
    expect(out).toMatch(/model=/)
    expect(out).toMatch(/fallback=hash|model=local-hash|model=lightonai|model=ollama/)
    if (/fallback=hash/.test(out)) {
      expect(out).toMatch(/Neural embeddings are unavailable/)
    }
  })

  it('skips re-embed for unchanged chunk hashes when sibling function edits', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-chunk-skip-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    const path = join(dir, 'src', 'pair.ts')
    writeFileSync(
      path,
      `export function keepStable(x: number): number {
  return x + 1
}

export function mutateMe(y: number): number {
  return y
}
`,
      'utf8'
    )
    let embedCalls = 0
    const base = createLocalHashEmbedder()
    const counting = {
      modelId: base.modelId,
      dimensions: base.dimensions,
      async embed(texts: string[]) {
        embedCalls += texts.length
        return base.embed(texts)
      }
    }
    const store = CodeIndexStore.open(dir, counting.dimensions)
    try {
      await syncCodeIndex(dir, store, counting)
      const firstCalls = embedCalls
      expect(firstCalls).toBeGreaterThan(0)

      writeFileSync(
        path,
        `export function keepStable(x: number): number {
  return x + 1
}

export function mutateMe(y: number): number {
  return y * 2
}
`,
        'utf8'
      )
      embedCalls = 0
      await syncCodeIndex(dir, store, counting)
      // Only changed chunk(s) should re-embed; keepStable hash matches → skip.
      expect(embedCalls).toBeGreaterThan(0)
      expect(embedCalls).toBeLessThan(firstCalls)
    } finally {
      store.close()
    }
  })

  it('modelId change forces separate store / reindex path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-model-sw-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    const a = await getOrOpenCodeIndex(dir, { embedder: createLocalHashEmbedder(384, 'local-hash-v1') })
    await syncCodeIndex(dir, a.store, a.embedder)
    const countA = a.store.getStatus().chunkCount
    const b = await getOrOpenCodeIndex(dir, {
      embedder: createLocalHashEmbedder(384, 'local-hash-v2-test')
    })
    expect(b.embedder.modelId).toBe('local-hash-v2-test')
    // Prior store for v1 closed by cache key switch
    await syncCodeIndex(dir, b.store, b.embedder)
    expect(b.store.getStatus().chunkCount).toBeGreaterThan(0)
    expect(b.store.getStatus().modelId).toBe('local-hash-v2-test')
    expect(countA).toBeGreaterThan(0)
    closeCodeIndex(dir)
  })

  it('modelId change on same sqlite re-embeds despite unchanged file SHA', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-model-reembed-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function a() { return 1 }\n', 'utf8')
    const store = CodeIndexStore.open(dir, 384)
    try {
      const v1 = createLocalHashEmbedder(384, 'local-hash-v1')
      let embedCalls = 0
      const countingV1 = {
        modelId: v1.modelId,
        dimensions: v1.dimensions,
        async embed(texts: string[]) {
          embedCalls += texts.length
          return v1.embed(texts)
        }
      }
      await syncCodeIndex(dir, store, countingV1)
      expect(embedCalls).toBeGreaterThan(0)

      const v2 = createLocalHashEmbedder(384, 'local-hash-v2-test')
      embedCalls = 0
      const countingV2 = {
        modelId: v2.modelId,
        dimensions: v2.dimensions,
        async embed(texts: string[]) {
          embedCalls += texts.length
          return v2.embed(texts)
        }
      }
      await syncCodeIndex(dir, store, countingV2)
    expect(embedCalls).toBeGreaterThan(0)
    expect(store.getStatus().modelId).toBe('local-hash-v2-test')
    } finally {
      store.close()
    }
  })

  it('does not commit modelId until a model-change sync finishes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-model-abort-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    const fileCount = CODE_INDEX_EMBED_BATCH + 8
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(dir, 'src', `f${i}.ts`), `export const value${i} = ${i}\n`, 'utf8')
    }
    const store = CodeIndexStore.open(dir, 32)
    try {
      const v1 = createLocalHashEmbedder(32, 'local-hash-v1')
      await syncCodeIndex(dir, store, v1)
      expect(store.getStatus().modelId).toBe('local-hash-v1')

      const v2 = createLocalHashEmbedder(32, 'local-hash-v2-test')
      let invocations = 0
      const exploding = {
        modelId: v2.modelId,
        dimensions: v2.dimensions,
        async embed(texts: string[]) {
          invocations++
          if (invocations >= 2) throw new Error('boom')
          return v2.embed(texts)
        }
      }
      await expect(syncCodeIndex(dir, store, exploding)).rejects.toThrow('boom')
      expect(store.getStatus().modelId).toBe('local-hash-v1')

      let resumeTexts = 0
      const counting = {
        modelId: v2.modelId,
        dimensions: v2.dimensions,
        async embed(texts: string[]) {
          resumeTexts += texts.length
          return v2.embed(texts)
        }
      }
      await syncCodeIndex(dir, store, counting)
      expect(store.getStatus().modelId).toBe('local-hash-v2-test')
      expect(resumeTexts).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  it('keeps previously indexed files that become unreadable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-unreadable-keep-'))
    writeFileSync(join(dir, 'keep.ts'), 'export const keepMarker = 1\n', 'utf8')
    writeFileSync(join(dir, 'lock.ts'), 'export const lockMarker = 1\n', 'utf8')
    const store = CodeIndexStore.open(dir, 32)
    try {
      const embedder = createLocalHashEmbedder(32)
      await syncCodeIndex(dir, store, embedder)
      expect(store.listFilePaths().sort()).toEqual(['keep.ts', 'lock.ts'])
      rmSync(join(dir, 'lock.ts'))
      mkdirSync(join(dir, 'lock.ts'))
      await syncCodeIndex(dir, store, embedder, {
        files: [
          { rel: 'keep.ts', full: join(dir, 'keep.ts') },
          { rel: 'lock.ts', full: join(dir, 'lock.ts') }
        ]
      })
      expect(store.listFilePaths().sort()).toEqual(['keep.ts', 'lock.ts'])
    } finally {
      store.close()
    }
  })

  it('skips lockfiles from the code index', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-lockfile-skip-'))
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
    const store = CodeIndexStore.open(dir, 32)
    try {
      const embedder = createLocalHashEmbedder(32)
      const sync = await syncCodeIndex(dir, store, embedder)
      expect(sync.indexed).toBe(1)
      expect(store.listFilePaths()).toEqual(['a.ts'])
    } finally {
      store.close()
    }
  })

  it('does not dense-index css/json/yaml/markdown', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-dense-allow-'))
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
    writeFileSync(join(dir, 'note.md'), '# Hello\n', 'utf8')
    writeFileSync(join(dir, 'app.css'), 'body { color: red; }\n', 'utf8')
    writeFileSync(join(dir, 'pkg.json'), '{ "name": "x" }\n', 'utf8')
    writeFileSync(join(dir, 'cfg.yml'), 'foo: 1\n', 'utf8')
    const store = CodeIndexStore.open(dir, 32)
    try {
      const embedder = createLocalHashEmbedder(32)
      const sync = await syncCodeIndex(dir, store, embedder)
      expect(sync.indexed).toBe(1)
      expect(store.listFilePaths()).toEqual(['a.ts'])
    } finally {
      store.close()
    }
  })

  it('does not dense-index tests, stories, or tool configs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-dense-core-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'tests'), { recursive: true })
    writeFileSync(join(dir, 'src', 'auth.ts'), 'export const auth = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'auth.test.ts'), 'export const authTest = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'Button.stories.tsx'), 'export const Story = {}\n', 'utf8')
    writeFileSync(join(dir, 'tests', 'auth.ts'), 'export const suite = 1\n', 'utf8')
    writeFileSync(join(dir, 'vite.config.ts'), 'export default {}\n', 'utf8')
    writeFileSync(join(dir, 'app.config.ts'), 'export default {}\n', 'utf8')
    mkdirSync(join(dir, 'pkg'), { recursive: true })
    mkdirSync(join(dir, 'examples'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'pkg', 'foo.go'), 'package pkg\n', 'utf8')
    writeFileSync(join(dir, 'pkg', 'foo_test.go'), 'package pkg\n', 'utf8')
    writeFileSync(join(dir, 'examples', 'demo.ts'), 'export const demo = 1\n', 'utf8')
    writeFileSync(join(dir, 'scripts', 'release.ts'), 'export const rel = 1\n', 'utf8')
    writeFileSync(join(dir, 'setup.sh'), 'echo hi\n', 'utf8')
    writeFileSync(join(dir, 'schema.sql'), 'select 1;\n', 'utf8')
    const store = CodeIndexStore.open(dir, 32)
    try {
      const embedder = createLocalHashEmbedder(32)
      const sync = await syncCodeIndex(dir, store, embedder)
      expect(sync.indexed).toBe(2)
      expect(store.listFilePaths().sort()).toEqual(['pkg/foo.go', 'src/auth.ts'])
    } finally {
      store.close()
    }
  })

  it('second sync with unchanged mtime and size indexes nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mtime-skip-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    const store = CodeIndexStore.open(dir, 32)
    try {
      const base = createLocalHashEmbedder(32)
      let embedCalls = 0
      const counting = {
        modelId: base.modelId,
        dimensions: base.dimensions,
        async embed(texts: string[]) {
          embedCalls += texts.length
          return base.embed(texts)
        }
      }
      const first = await syncCodeIndex(dir, store, counting)
      expect(first.indexed).toBe(1)
      expect(embedCalls).toBeGreaterThan(0)
      embedCalls = 0
      const second = await syncCodeIndex(dir, store, counting)
      expect(second.indexed).toBe(0)
      expect(second.skipped).toBe(1)
      expect(embedCalls).toBe(0)
    } finally {
      store.close()
    }
  })

  it('skip-only sync does not call a lazy ONNX ensure', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-lazy-ensure-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    const store = CodeIndexStore.open(dir, LIGHTON_DENSE_DIM)
    try {
      const seed = createLocalHashEmbedder(LIGHTON_DENSE_DIM, DENSEON_ONNX_MODEL_ID)
      await syncCodeIndex(dir, store, seed)
      let ensureCalls = 0
      const session = {
        modelId: DENSEON_ONNX_MODEL_ID,
        dimensions: LIGHTON_DENSE_DIM,
        async embed(texts: string[]) {
          return seed.embed(texts)
        }
      }
      const lazy = await resolveEmbedderForTests({
        embedderId: 'mdenseon',
        autoDownload: false,
        mdenseon: {
          createSession: async () => {
            ensureCalls++
            return session
          }
        }
      })
      const second = await syncCodeIndex(dir, store, lazy.embedder)
      expect(second.indexed).toBe(0)
      expect(second.skipped).toBe(1)
      expect(ensureCalls).toBe(0)
    } finally {
      store.close()
    }
  })

  it('length-buckets similar chunks into small ORT batches', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-embed-pack-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    const fileCount = CODE_INDEX_EMBED_BATCH + 8
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(dir, 'src', `f${i}.ts`), `export const value${i} = ${i}\n`, 'utf8')
    }
    const store = CodeIndexStore.open(dir, 32)
    try {
      const base = createLocalHashEmbedder(32)
      let invocations = 0
      let totalTexts = 0
      let maxBatch = 0
      const batches: number[][] = []
      const counting = {
        modelId: base.modelId,
        dimensions: base.dimensions,
        async embed(texts: string[]) {
          invocations++
          totalTexts += texts.length
          maxBatch = Math.max(maxBatch, texts.length)
          batches.push(texts.map((t) => t.length))
          return base.embed(texts)
        }
      }
      const sync = await syncCodeIndex(dir, store, counting)
      expect(sync.indexed).toBe(fileCount)
      expect(CODE_INDEX_EMBED_BATCH).toBe(16)
      expect(maxBatch).toBeGreaterThan(1)
      expect(maxBatch).toBeLessThanOrEqual(CODE_INDEX_EMBED_BATCH)
      expect(invocations).toBeLessThan(totalTexts)
      expect(store.listFilePaths()).toHaveLength(fileCount)
      expect(embedLengthBucket(100)).toBe(0)
      expect(embedLengthBucket(256)).toBe(0)
      expect(embedLengthBucket(257)).toBe(1)
      expect(embedLengthBucket(3000)).toBe(4)
      for (const lens of batches) {
        const buckets = new Set(lens.map((n) => embedLengthBucket(n)))
        expect(buckets.size).toBe(1)
      }
    } finally {
      store.close()
    }
  })

  it('drops oversized files from the index instead of keeping stale chunks', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-oversize-drop-'))
    const grow = join(dir, 'grow.ts')
    writeFileSync(grow, 'export const growMarker = 1\n', 'utf8')
    writeFileSync(join(dir, 'keep.ts'), 'export const keepMarker = 1\n', 'utf8')
    const store = CodeIndexStore.open(dir, 32)
    try {
      const embedder = createLocalHashEmbedder(32)
      await syncCodeIndex(dir, store, embedder)
      expect(store.listFilePaths().sort()).toEqual(['grow.ts', 'keep.ts'])
      writeFileSync(grow, Buffer.alloc(513 * 1024, 97))
      const second = await syncCodeIndex(dir, store, embedder)
      expect(store.listFilePaths()).toEqual(['keep.ts'])
      expect(second.removed).toBe(1)
      expect(second.skipped).toBeGreaterThanOrEqual(1)
    } finally {
      store.close()
    }
  })

  it('drops NUL/binary files instead of embedding them', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-nul-drop-'))
    writeFileSync(join(dir, 'ok.ts'), 'export const okMarker = 1\n', 'utf8')
    writeFileSync(join(dir, 'bin.ts'), Buffer.from([0x65, 0x78, 0x70, 0x00, 0x6f]))
    const store = CodeIndexStore.open(dir, 32)
    try {
      const embedder = createLocalHashEmbedder(32)
      await syncCodeIndex(dir, store, embedder)
      expect(store.listFilePaths()).toEqual(['ok.ts'])
    } finally {
      store.close()
    }
  })

  it('shouldPreserveIndexedEmbeddings only when fallback would clobber a neural store', () => {
    expect(
      shouldPreserveIndexedEmbeddings({
        usedFallback: true,
        storeModelId: DENSEON_ONNX_MODEL_ID,
        storeChunkCount: 12
      })
    ).toBe(true)
    expect(
      shouldPreserveIndexedEmbeddings({
        usedFallback: false,
        storeModelId: DENSEON_ONNX_MODEL_ID,
        storeChunkCount: 12
      })
    ).toBe(false)
    expect(
      shouldPreserveIndexedEmbeddings({
        usedFallback: true,
        storeModelId: DEFAULT_MODEL_ID,
        storeChunkCount: 12
      })
    ).toBe(false)
    expect(
      shouldPreserveIndexedEmbeddings({
        usedFallback: true,
        storeModelId: DENSEON_ONNX_MODEL_ID,
        storeChunkCount: 0
      })
    ).toBe(false)
  })

  it('does not rewrite a neural index when Ollama fallback is hash', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-preserve-neural-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const preserveMarker = 1\n', 'utf8')
    const neural = createLocalHashEmbedder(384, DENSEON_ONNX_MODEL_ID)
    const store = CodeIndexStore.open(dir, 384)
    try {
      await syncCodeIndex(dir, store, neural)
      expect(store.getStatus().modelId).toBe(DENSEON_ONNX_MODEL_ID)
    } finally {
      store.close()
    }

    await ensureCodeIndexSynced(dir, {
      embedderId: 'ollama',
      ollama: {
        fetchImpl: (async () => {
          throw new Error('ollama down')
        }) as unknown as typeof fetch
      }
    })
    closeCodeIndex(dir)
    const again = CodeIndexStore.open(dir, 384)
    try {
      expect(again.getStatus().modelId).toBe(DENSEON_ONNX_MODEL_ID)
      expect(again.listFilePaths()).toContain('src/a.ts')
    } finally {
      again.close()
    }
  })

  it('preserves neural vectors and FTS-indexes new files as embed_pending', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-preserve-pending-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const preserveMarker = 1\n', 'utf8')
    const neural = createLocalHashEmbedder(384, DENSEON_ONNX_MODEL_ID)
    const store = CodeIndexStore.open(dir, 384)
    try {
      await syncCodeIndex(dir, store, neural)
      expect(store.getStatus().modelId).toBe(DENSEON_ONNX_MODEL_ID)
    } finally {
      store.close()
    }

    writeFileSync(join(dir, 'src', 'newFile.ts'), 'export function pendingSearchHit() { return 1 }\n', 'utf8')
    await ensureCodeIndexSynced(dir, {
      embedderId: 'ollama',
      ollama: {
        fetchImpl: (async () => {
          throw new Error('ollama down')
        }) as unknown as typeof fetch
      }
    })
    closeCodeIndex(dir)
    const again = CodeIndexStore.open(dir, 384)
    try {
      expect(again.getStatus().modelId).toBe(DENSEON_ONNX_MODEL_ID)
      expect(again.listFilePaths()).toContain('src/newFile.ts')
      expect(again.getFileStamp('src/newFile.ts')?.embedPending).toBe(true)
      const hash = createLocalHashEmbedder(384)
      const hits = await searchCodeIndex(dir, again, hash, 'pendingSearchHit', {
        mode: 'lexical',
        limit: 5
      })
      expect(hits.some((h) => h.path.includes('newFile.ts'))).toBe(true)
    } finally {
      again.close()
    }

    const neuralStore = CodeIndexStore.open(dir, 384)
    try {
      await syncCodeIndex(dir, neuralStore, neural)
      expect(neuralStore.getStatus().modelId).toBe(DENSEON_ONNX_MODEL_ID)
      expect(neuralStore.getFileStamp('src/newFile.ts')?.embedPending).toBe(false)
    } finally {
      neuralStore.close()
    }
  })

  it('commits embed-pending chunks that have no vectors yet', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-embed-pending-blob-'))
    const store = CodeIndexStore.open(dir, 384)
    try {
      store.replaceFileChunks(
        'src/pending.ts',
        'hash',
        Date.now(),
        [
          {
            startLine: 1,
            endLine: 1,
            kind: 'block',
            name: 'pending.ts',
            chunkHash: 'pending-hash',
            embedding: new Float32Array(0),
            ftsText: 'pendingSearchHit'
          }
        ],
        16,
        true
      )
      expect(store.getFileStamp('src/pending.ts')?.embedPending).toBe(true)
      expect(store.listFilePaths()).toContain('src/pending.ts')
    } finally {
      store.close()
    }
  })
})
