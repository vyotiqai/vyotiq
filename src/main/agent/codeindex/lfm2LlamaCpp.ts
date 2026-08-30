/**
 * LFM2.5-Embedding-350M via a bundled llama.cpp Node binding (node-llama-cpp).
 *
 * This is the zero-setup LFM2 path: it downloads the GGUF straight from Hugging
 * Face and runs it with llama.cpp — no Ollama server and no manual ONNX export
 * required. node-llama-cpp is an OPTIONAL native dependency, so we never
 * statically import it; when it is absent the LFM2 resolver falls back to
 * Ollama or DenseOn and the app still builds and runs.
 *
 * Creation is a cheap availability probe only (module import + GGUF resolve);
 * the heavy native model load is deferred to the first embed() call. With
 * utilityProcess routing, main resolves this embedder but never embeds — the
 * child process pays the model load and keeps the VRAM off main. The
 * in-process fallback (tests / utility disabled) loads on first embed too.
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
/** Measured optimum (240 vs 393 ms/chunk at "auto"); over-length inputs shrink-retry below. */
const LLMCPP_EMBEDDING_CONTEXT_SIZE = 1024

type LlamaCppModule = {
  getLlama: (opts?: unknown) => Promise<{
    loadModel: (opts: { modelPath: string; gpuLayers?: number }) => Promise<LlamaModelLike>
  }>
  resolveModelFile: (path: string, opts?: unknown) => Promise<string>
}

type LlamaEmbeddingLike = { vector: number[] | Float32Array }

type LlamaEmbeddingContextLike = {
  getEmbeddingFor: (text: string) => Promise<LlamaEmbeddingLike>
  dispose?: () => Promise<void>
}

type LlamaModelLike = {
  createEmbeddingContext: (opts?: {
    threads?: number
    contextSize?: number | 'auto'
  }) => Promise<LlamaEmbeddingContextLike>
  dispose?: () => Promise<void>
}

let cached: Embedder | null = null

let cachedDispose: (() => void) | null = null

/** Drop the cached embedder and free the native llama.cpp model (embedder change). */
export function clearLfm2LlamaCppCache(): void {
  cached = null
  const dispose = cachedDispose
  cachedDispose = null
  dispose?.()
}

export async function createLfm2LlamaCppEmbedder(
  opts: Lfm2LlamaCppOptions = {}
): Promise<Embedder> {
  if (cached) return cached
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const mod = (await import(NODE_LLAMACPP).catch(() => null)) as LlamaCppModule | null
  if (!mod) throw new Error('node-llama-cpp is not installed')
  const { resolveModelFile } = mod

  // Availability probe: resolve (download if needed) the GGUF so a missing
  // model still falls through to Ollama/DenseOn at resolve time. The native
  // binding and model load stay deferred to the first embed call.
  const repo = opts.hfRepo ?? DEFAULT_LFM2_GGUF_HF
  const modelPath = opts.modelPath ?? (await resolveModelFile(repo))
  if (!modelPath) throw new Error('LFM2 GGUF is not available locally')

  let loaded: { ctx: LlamaEmbeddingContextLike; model: LlamaModelLike } | null = null
  let loadPromise: Promise<LlamaEmbeddingContextLike> | null = null

  const loadCtx = (loadSignal?: AbortSignal): Promise<LlamaEmbeddingContextLike> => {
    if (loaded) return Promise.resolve(loaded.ctx)
    if (loadSignal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    if (!loadPromise) {
      loadPromise = (async () => {
        const reload = (await import(NODE_LLAMACPP).catch(() => null)) as LlamaCppModule | null
        if (!reload) throw new Error('node-llama-cpp is not installed')
        const { getLlama } = reload
        const llama = await getLlama()
        const model = await llama.loadModel({ modelPath })
        try {
          // Explicit context: "auto" measured ~393 vs ~240 ms/chunk and can
          // exceed free VRAM. llama.cpp throws on over-length input — the
          // shrink-retry below handles that instead of growing the context.
          const ctx = await model.createEmbeddingContext({
            contextSize: LLMCPP_EMBEDDING_CONTEXT_SIZE,
            threads: Math.max(1, Math.min(8, cpus().length || 1))
          })
          loaded = { ctx, model }
          cachedDispose = () => {
            try {
              void ctx.dispose?.()?.catch(() => undefined)
            } catch {
              /* ignore */
            }
            try {
              void model.dispose?.()?.catch(() => undefined)
            } catch {
              /* ignore */
            }
          }
          return ctx
        } catch (err) {
          // Context creation can exceed free VRAM — free the loaded model before rethrowing.
          try {
            void model.dispose?.()?.catch(() => undefined)
          } catch {
            /* ignore */
          }
          loadPromise = null
          throw err
        }
      })()
    }
    return loadPromise
  }

  const embedder: Embedder = {
    modelId: `llmcpp:${repo.replace(/^hf:/, '')}`,
    dimensions: LFM2_EMBEDDING_DIM,
    async embed(texts, o) {
      const signal = o?.signal
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const role = o?.role ?? 'document'
      const prefix = role === 'query' ? 'query: ' : 'document: '
      const ctx = await loadCtx(signal)
      const out: Float32Array[] = []
      for (const t of texts) {
        // getEmbeddingFor takes no signal — stop between forwards. The
        // creation-time opts.signal is intentionally ignored: a cached
        // embedder must not inherit the first caller's stale abort state.
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const raw = await embedWithShrinkRetry(ctx, `${prefix}${t}`)
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

function isOverLengthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /longer than the context|context size/i.test(msg)
}

/**
 * llama.cpp throws "Input is longer than the context size" instead of
 * truncating — halve the input and retry (max 3 shrinks) so one long chunk
 * cannot fail the whole sync.
 */
async function embedWithShrinkRetry(
  ctx: LlamaEmbeddingContextLike,
  text: string
): Promise<LlamaEmbeddingLike> {
  let input = text
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.getEmbeddingFor(input)
    } catch (err) {
      if (attempt >= 3 || input.length === 0 || !isOverLengthError(err)) throw err
      input = input.slice(0, Math.floor(input.length / 2))
    }
  }
}
