import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Keep the bundled llama.cpp stage hermetic in unit tests: without this, the
// optional `node-llama-cpp` dep would trigger a real 229 MB GGUF download from
// Hugging Face. The real path is covered by a separate runtime smoke check.
vi.mock('node-llama-cpp', () => ({
  getLlama: vi.fn().mockRejectedValue(new Error('node-llama-cpp mocked unavailable in unit tests')),
  resolveModelFile: vi.fn()
}))
import {
  clearEmbedderFailCacheForTests,
  clearMDenseOnSessionForTests,
  createNeuralOnnxEmbedder,
  getNeuralArtifact,
  lfm2OnnxFiles,
  NEURAL_ARTIFACTS,
  neuralWeightsOnDisk,
  resolveEmbedderForTests,
  setCodeIndexModelsRootOverrideForTests,
  LFM2_EMBEDDING_MODEL_ID
} from '@main/agent/codeindex'
import { DEFAULT_CODE_INDEX_SETTINGS } from '@shared/ipc/schemas/settings'
import {
  DENSEON_ONNX_MODEL_ID,
  LFM2_EMBEDDING_DIM,
  MDENSEON_MODEL_ID,
  denseModelIdsCompatible,
  isNeuralDenseModelId,
  neuralModelFamily
} from '@main/agent/codeindex/types'
import { resetCodeIndexRuntimeStatusForTests } from '@main/agent/codeindex/modelStatus'

describe('codeindex LFM2.5-Embedding-350M integration', () => {
  let modelsRoot: string | null = null

  afterEach(() => {
    clearMDenseOnSessionForTests()
    clearEmbedderFailCacheForTests()
    resetCodeIndexRuntimeStatusForTests()
    setCodeIndexModelsRootOverrideForTests(null)
    if (modelsRoot) {
      rmSync(modelsRoot, { recursive: true, force: true })
      modelsRoot = null
    }
  })

  it('registry exposes LFM2 as a generic 1024-dim non-auto-downloaded artifact', () => {
    const lfm2 = getNeuralArtifact(LFM2_EMBEDDING_MODEL_ID)
    expect(lfm2).toBeDefined()
    expect(lfm2!.loader).toBe('generic')
    expect(lfm2!.dimensions).toBe(LFM2_EMBEDDING_DIM)
    expect(lfm2!.allowAutoDownload).toBe(false)
    expect(NEURAL_ARTIFACTS.some((a) => a.modelId === LFM2_EMBEDDING_MODEL_ID)).toBe(true)
  })

  it('lfm2OnnxFiles lists the exported graph + tokenizer, with no hub URL', () => {
    const files = lfm2OnnxFiles()
    expect(files.map((f) => f.relativePath)).toEqual([
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'onnx/model_quantized.onnx'
    ])
    expect(files.every((f) => f.url === '')).toBe(true)
  })

  it('compatibility treats LFM2 and LightOn as distinct families, LFM2 self-compatible', () => {
    expect(neuralModelFamily(LFM2_EMBEDDING_MODEL_ID)).toBe('lfm2')
    expect(neuralModelFamily(DENSEON_ONNX_MODEL_ID)).toBe('lighton')
    expect(isNeuralDenseModelId(LFM2_EMBEDDING_MODEL_ID)).toBe(true)
    // LFM2 <-> LightOn are different spaces (different dim) => not compatible.
    expect(denseModelIdsCompatible(LFM2_EMBEDDING_MODEL_ID, DENSEON_ONNX_MODEL_ID)).toBe(false)
    // same family (LightOn mDenseOn <-> DenseOn) remains compatible.
    expect(denseModelIdsCompatible(MDENSEON_MODEL_ID, DENSEON_ONNX_MODEL_ID)).toBe(true)
  })

  it('resolveEmbedder falls back to hash when LFM2 ONNX is absent and Ollama is down', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-lfm2-absent-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    const down = async () => {
      throw new Error('ollama down')
    }
    const resolved = await resolveEmbedderForTests({ embedderId: 'lfm2', ollama: { fetchImpl: down } })
    expect(resolved.usedFallback).toBe(true)
    expect(resolved.embedder.modelId).toBe('local-hash-v1')
  })

  it('resolveEmbedder uses local Ollama GGUF when LFM2 ONNX is absent but Ollama is reachable', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-lfm2-ollama-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    const fakeFetch = async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {}
      const texts: unknown[] = body.input ?? [body.prompt]
      const embeddings = texts.map(() => new Array(1024).fill(0.01))
      return { ok: true, json: async () => ({ embeddings }) }
    }
    const resolved = await resolveEmbedderForTests({
      embedderId: 'lfm2',
      ollama: { fetchImpl: fakeFetch }
    })
    expect(resolved.usedFallback).toBe(false)
    expect(resolved.embedder.modelId).toBe('ollama:hf.co/LiquidAI/LFM2.5-Embedding-350M-GGUF')
    expect(resolved.embedder.dimensions).toBe(1024)
  })

  it('default embedder setting is LightOn dense ONNX (utilityProcess batched)', () => {
    expect(DEFAULT_CODE_INDEX_SETTINGS.embedder).toBe('mdenseon')
    expect(DEFAULT_CODE_INDEX_SETTINGS.lfm2OllamaModel).toBe('hf.co/LiquidAI/LFM2.5-Embedding-350M-GGUF')
  })

  it('resolveEmbedder returns the LFM2 neural embedder when its ONNX is present', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-lfm2-present-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    const modelDir = join(modelsRoot, 'lfm2-embedding-onnx')
    mkdirSync(join(modelDir, 'onnx'), { recursive: true })
    for (const f of lfm2OnnxFiles()) {
      // touch the expected files so modelFilesPresent sees them.
      const p = join(modelDir, f.relativePath)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'x', 'utf8')
    }
    expect(neuralWeightsOnDisk(LFM2_EMBEDDING_MODEL_ID)).toBe(true)

    const resolved = await resolveEmbedderForTests({ embedderId: 'lfm2' })
    expect(resolved.usedFallback).toBe(false)
    // Lazy modelId resolves to the LFM2 id; dimensions are 1024.
    expect(resolved.embedder.modelId).toBe(LFM2_EMBEDDING_MODEL_ID)
    expect(resolved.embedder.dimensions).toBe(LFM2_EMBEDDING_DIM)
  })

  it('createNeuralOnnxEmbedder reports target model id and dimensions', () => {
    const session = {
      modelId: LFM2_EMBEDDING_MODEL_ID,
      dimensions: LFM2_EMBEDDING_DIM,
      async embed() {
        return []
      }
    }
    const embedder = createNeuralOnnxEmbedder({ targetModelId: LFM2_EMBEDDING_MODEL_ID, session })
    expect(embedder.modelId).toBe(LFM2_EMBEDDING_MODEL_ID)
    expect(embedder.dimensions).toBe(LFM2_EMBEDDING_DIM)
  })
})
