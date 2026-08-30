import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearEmbedderFailCacheForTests,
  clearLfm2LlamaCppCache,
  closeCodeIndex,
  ensureCodeIndexSynced,
  resolveEmbedderForTests,
  setCodeIndexModelsRootOverrideForTests
} from '@main/agent/codeindex'
import type { Embedder } from '@main/agent/codeindex/embed'
import { resetCodeIndexRuntimeStatusForTests } from '@main/agent/codeindex/modelStatus'

const nlcMocks = vi.hoisted(() => {
  const ctx = {
    getEmbeddingFor: vi.fn(async () => ({ vector: new Array<number>(1024).fill(0.01) })),
    dispose: vi.fn(async () => undefined)
  }
  const model = {
    createEmbeddingContext: vi.fn(async () => ctx),
    dispose: vi.fn(async () => undefined)
  }
  const loadModel = vi.fn(async () => model)
  return {
    ctx,
    model,
    loadModel,
    getLlama: vi.fn(async () => ({ loadModel })),
    resolveModelFile: vi.fn(async () => '/fake/LFM2.5-Embedding-350M.Q4_K_M.gguf')
  }
})

const routingSyncMock = vi.hoisted(() => vi.fn())

// Simulate `node-llama-cpp` being installed + a working llama.cpp GGUF (real
// v3.20 API shape) without any network download, and pin the utility child as
// available so sync routing can be asserted.
vi.mock('node-llama-cpp', () => ({
  getLlama: nlcMocks.getLlama,
  resolveModelFile: nlcMocks.resolveModelFile
}))

vi.mock('@main/agent/codeindex/embedUtilityClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/codeindex/embedUtilityClient')>()
  return {
    ...actual,
    canUseIndexSyncUtility: () => true,
    canUseIndexSearchUtility: () => true,
    getEmbedUtilityClient: () => ({
      syncCode: routingSyncMock,
      shutdown: async () => undefined
    })
  }
})

describe('codeindex LFM2 llama.cpp stage', () => {
  let modelsRoot: string | null = null
  let dir: string | undefined

  afterEach(() => {
    clearEmbedderFailCacheForTests()
    resetCodeIndexRuntimeStatusForTests()
    setCodeIndexModelsRootOverrideForTests(null)
    clearLfm2LlamaCppCache()
    routingSyncMock.mockReset()
    if (dir) {
      closeCodeIndex(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      dir = undefined
    }
    if (modelsRoot) {
      rmSync(modelsRoot, { recursive: true, force: true })
      modelsRoot = null
    }
  })

  it('prefers bundled llama.cpp GGUF over Ollama when LFM2 ONNX is absent', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-lfm2-llamacpp-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    const resolved = await resolveEmbedderForTests({ embedderId: 'lfm2' })
    expect(resolved.usedFallback).toBe(false)
    expect(resolved.embedder.modelId).toBe('llmcpp:LiquidAI/LFM2.5-Embedding-350M-GGUF')
    expect(resolved.embedder.dimensions).toBe(1024)
    const [vec] = await resolved.embedder.embed(['query: how does fallback work'], { role: 'query' })
    expect(vec.length).toBe(1024)
  })

  it('defers the native model load to first embed and passes the measured context size', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-lfm2-llamacpp-lazy-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    clearLfm2LlamaCppCache()
    nlcMocks.loadModel.mockClear()
    nlcMocks.ctx.getEmbeddingFor.mockClear()
    nlcMocks.model.createEmbeddingContext.mockClear()
    nlcMocks.ctx.dispose.mockClear()
    nlcMocks.model.dispose.mockClear()
    const first = await resolveEmbedderForTests({ embedderId: 'lfm2' })
    // Creation is a probe only — no native model, no forwards on the caller.
    expect(nlcMocks.loadModel).not.toHaveBeenCalled()
    expect(nlcMocks.ctx.getEmbeddingFor).not.toHaveBeenCalled()
    await first.embedder.embed(['warm'])
    expect(nlcMocks.loadModel).toHaveBeenCalledTimes(1)
    expect(nlcMocks.model.createEmbeddingContext.mock.calls[0]?.[0]).toMatchObject({
      contextSize: 1024
    })
    clearLfm2LlamaCppCache()
    expect(nlcMocks.ctx.dispose).toHaveBeenCalledTimes(1)
    expect(nlcMocks.model.dispose).toHaveBeenCalledTimes(1)
    const second = await resolveEmbedderForTests({ embedderId: 'lfm2' })
    expect(second.embedder).not.toBe(first.embedder)
    await second.embedder.embed(['again'])
    expect(nlcMocks.loadModel).toHaveBeenCalledTimes(2)
  })

  it('embed ignores a stale creation-time signal and honors the per-call signal', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-lfm2-llamacpp-abort-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    clearLfm2LlamaCppCache()
    const creation = new AbortController()
    const resolved = await resolveEmbedderForTests({ embedderId: 'lfm2', signal: creation.signal })
    creation.abort()
    // The cached embedder must not inherit the first caller's aborted signal.
    const [vec] = await resolved.embedder.embed(['still fine'])
    expect(vec.length).toBe(1024)
    // A per-call abort must stop before any forward runs.
    nlcMocks.ctx.getEmbeddingFor.mockClear()
    const perCall = new AbortController()
    perCall.abort()
    await expect(
      resolved.embedder.embed(['never'], { signal: perCall.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(nlcMocks.ctx.getEmbeddingFor).not.toHaveBeenCalled()
  })

  it('shrinks and retries when llama.cpp rejects over-length input', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-lfm2-llamacpp-shrink-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    clearLfm2LlamaCppCache()
    nlcMocks.ctx.getEmbeddingFor.mockClear()
    nlcMocks.ctx.getEmbeddingFor
      .mockRejectedValueOnce(new Error('Input is longer than the context size (1024)'))
      .mockRejectedValueOnce(new Error('Input is longer than the context size (1024)'))
    const resolved = await resolveEmbedderForTests({ embedderId: 'lfm2' })
    const [vec] = await resolved.embedder.embed(['x'.repeat(5000)])
    expect(vec.length).toBe(1024)
    expect(nlcMocks.ctx.getEmbeddingFor).toHaveBeenCalledTimes(3)
  })

  it('routes llamacpp sync through the utility child (no in-process GGUF on main)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-llamacpp-route-'))
    routingSyncMock.mockResolvedValue({
      scanned: 0,
      indexed: 0,
      skipped: 0,
      removed: 0,
      status: {
        ready: false,
        modelId: 'llmcpp:test',
        fileCount: 0,
        chunkCount: 0,
        lastIndexedAt: null
      },
      partial: false,
      syncComplete: false,
      cursor: null
    })
    const embedder: Embedder = {
      modelId: 'llmcpp:test',
      dimensions: 1024,
      async embed() {
        return []
      }
    }
    await ensureCodeIndexSynced(dir, { embedder })
    expect(routingSyncMock).toHaveBeenCalledTimes(1)
    expect(routingSyncMock.mock.calls[0]?.[0]).toMatchObject({
      embedderKind: 'llamacpp',
      modelId: 'llmcpp:test'
    })
  })
})
