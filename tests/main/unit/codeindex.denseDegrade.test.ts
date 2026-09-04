import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodeIndexStore,
  closeCodeIndex,
  denseOnOnnxFiles,
  ensureLightOnBootstrapWeights,
  modelFilesPresent,
  searchCodeIndex,
  setCodeIndexModelsRootOverrideForTests,
  syncCodeIndex,
  DENSEON_ONNX_MODEL_ID,
  LIGHTON_DENSE_DIM
} from '@main/agent/codeindex'
import { resetCodeIndexRuntimeStatusForTests } from '@main/agent/codeindex/modelStatus'

const AUTH_SRC = `export function validateAuthToken(token: string): boolean {
  if (!token) return false
  return token.startsWith('Bearer ')
}
`

describe('codeindex dense-failure lexical degrade', () => {
  let dir: string

  afterEach(() => {
    resetCodeIndexRuntimeStatusForTests()
    if (dir) {
      closeCodeIndex(dir)
      rmSync(dir, { recursive: true, force: true })
      dir = undefined as unknown as string
    }
  })

  it('serves FTS hits when the dense query embedder fails mid-search', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-degrade-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'auth.ts'), AUTH_SRC, 'utf8')
    // Document role works (sync embeds), query role throws (weights missing
    // at search time). Same model id keeps the store "compatible" so the
    // dense lane is genuinely attempted before the degrade.
    const embedder = {
      modelId: DENSEON_ONNX_MODEL_ID,
      dimensions: LIGHTON_DENSE_DIM,
      async embed(texts: string[], opts?: { role?: 'query' | 'document' }) {
        if (opts?.role === 'query') throw new Error('weights unavailable')
        return texts.map((t) => {
          const v = new Float32Array(LIGHTON_DENSE_DIM)
          v[t.length % LIGHTON_DENSE_DIM] = 1
          return v
        })
      }
    }
    const store = CodeIndexStore.open(dir, LIGHTON_DENSE_DIM)
    try {
      const sync = await syncCodeIndex(dir, store, embedder)
      expect(sync.indexed).toBeGreaterThan(0)
      const hits = await searchCodeIndex(dir, store, embedder, 'validateAuthToken', {
        limit: 5,
        mode: 'hybrid'
      })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]?.path).toBe('src/auth.ts')
    } finally {
      store.close()
    }
  })
})

describe('codeindex bootstrap weights (write lane)', () => {
  let modelsRoot: string

  afterEach(() => {
    resetCodeIndexRuntimeStatusForTests()
    setCodeIndexModelsRootOverrideForTests(null)
    if (modelsRoot) {
      rmSync(modelsRoot, { recursive: true, force: true })
      modelsRoot = undefined as unknown as string
    }
  })

  it('downloads once, is single-flight, and short-circuits when present', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-bootstrap-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    const files = denseOnOnnxFiles()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      const body = 'onnx-bytes'
      return {
        ok: true,
        headers: { get: () => String(body.length) },
        body: ReadableStreamFrom(body)
      }
    }) as unknown as typeof fetch

    const [a, b] = await Promise.all([
      ensureLightOnBootstrapWeights({ fetchImpl }),
      ensureLightOnBootstrapWeights({ fetchImpl })
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(calls).toBe(files.length)
    expect(modelFilesPresent(join(modelsRoot, 'DenseOn-onnx-int8'), files)).toBe(true)

    const warm = await ensureLightOnBootstrapWeights({ fetchImpl })
    expect(warm).toBe(true)
    expect(calls).toBe(files.length)
  })

  it('returns false on failed download instead of throwing', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-bootstrap-fail-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch
    const ok = await ensureLightOnBootstrapWeights({ fetchImpl })
    expect(ok).toBe(false)
  })
})

function ReadableStreamFrom(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc)
      controller.close()
    }
  })
}
