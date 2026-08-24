/**
 * LFM2.5-Embedding-350M via a bundled llama.cpp Node binding (node-llama-cpp).
 *
 * This is the zero-setup LFM2 path: it downloads the GGUF straight from Hugging
 * Face and runs it in-process with llama.cpp — no Ollama server and no manual
 * ONNX export required. node-llama-cpp is an OPTIONAL native dependency, so we
 * never statically import it; when it is absent the LFM2 resolver falls back to
 * Ollama or DenseOn and the app still builds and runs.
 *
 * node-llama-cpp API notes (v3.20): getLlama() -> loadModel({ modelPath }) ->
 * createEmbeddingContext() -> ctx.getEmbeddingFor(text) -> { vector }. Pooling is
 * read from the GGUF metadata (LFM2.5 ships with CLS pooling), so we just apply the
 * query/document prefix the model was trained with and L2-normalize defensively.
 */
import { cpus } from 'os'
import type { Embedder } from './embed'
import { LFM2_EMBEDDING_DIM } from './types'

export type Lfm2LlamaCppOptions = {
  signal?: AbortSignal
  /** Override the HF GGUF repo (default LiquidAI/LFM2.5-Embedding-350M-GGUF). */
  hfRepo?: string
  /** Local GGUF path to use instead of downloading from HF. */
  modelPath?: string
}

const NODE_LLAMACPP = 'node-llama-cpp'
const DEFAULT_LFM2_GGUF_HF = 'hf:LiquidAI/LFM2.5-Embedding-350M-GGUF'

type LlamaCppModule = {
  getLlama: (opts?: unknown) => Promise<{
    loadModel: (opts: { modelPath: string; gpuLayers?: number }) => Promise<LlamaModelLike>
  }>
  resolveModelFile: (path: string, opts?: unknown) => Promise<string>
}

type LlamaEmbeddingLike = { vector: number[] | Float32Array }

type LlamaEmbeddingContextLike = {
  getEmbeddingFor: (text: string) => Promise<LlamaEmbeddingLike>
}

type LlamaModelLike = {
  createEmbeddingContext: (opts?: { threads?: number }) => Promise<LlamaEmbeddingContextLike>
}

let cached: Embedder | null = null

export function clearLfm2LlamaCppCache(): void {
  cached = null
}

export async function createLfm2LlamaCppEmbedder(
  opts: Lfm2LlamaCppOptions = {}
): Promise<Embedder> {
  if (cached) return cached
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const mod = (await import(NODE_LLAMACPP).catch(() => null)) as LlamaCppModule | null
  if (!mod) throw new Error('node-llama-cpp is not installed')
  const { getLlama, resolveModelFile } = mod

  const llama = await getLlama()
  const repo = opts.hfRepo ?? DEFAULT_LFM2_GGUF_HF
  const modelPath = opts.modelPath ?? (await resolveModelFile(repo))
  const model = await llama.loadModel({ modelPath })
  const ctx = await model.createEmbeddingContext({
    threads: Math.max(1, Math.min(8, cpus().length || 1))
  })

  const modelId = `llmcpp:${repo.replace(/^hf:/, '')}`
  const embedder: Embedder = {
    modelId,
    dimensions: LFM2_EMBEDDING_DIM,
    async embed(texts, o) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const role = o?.role ?? 'document'
      const prefix = role === 'query' ? 'query: ' : 'document: '
      const out: Float32Array[] = []
      for (const t of texts) {
        const raw = await ctx.getEmbeddingFor(`${prefix}${t}`)
        const vec = raw.vector instanceof Float32Array
          ? raw.vector
          : Float32Array.from(raw.vector)
        out.push(l2Normalize(vec))
      }
      return out
    }
  }
  cached = embedder
  return embedder
}

function l2Normalize(v: Float32Array): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i]! /= n
  return v
}
