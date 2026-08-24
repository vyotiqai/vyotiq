import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearEmbedderFailCacheForTests,
  resolveEmbedderForTests,
  setCodeIndexModelsRootOverrideForTests
} from '@main/agent/codeindex'
import { resetCodeIndexRuntimeStatusForTests } from '@main/agent/codeindex/modelStatus'

// Simulate `node-llama-cpp` being installed + a working llama.cpp GGUF, so we
// can lock the stage-2 (bundled llama.cpp) wiring against the real v3.20 API
// (getLlama -> loadModel -> createEmbeddingContext -> getEmbeddingFor) without
// any network download.
vi.mock('node-llama-cpp', () => ({
  getLlama: vi.fn().mockResolvedValue({
    loadModel: vi.fn().mockResolvedValue({
      createEmbeddingContext: vi.fn().mockResolvedValue({
        getEmbeddingFor: vi.fn().mockResolvedValue({ vector: new Array(1024).fill(0.01) })
      })
    })
  }),
  resolveModelFile: vi.fn().mockResolvedValue('/fake/LFM2.5-Embedding-350M.Q4_K_M.gguf')
}))

describe('codeindex LFM2 llama.cpp stage', () => {
  let modelsRoot: string | null = null

  afterEach(() => {
    clearEmbedderFailCacheForTests()
    resetCodeIndexRuntimeStatusForTests()
    setCodeIndexModelsRootOverrideForTests(null)
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
})
