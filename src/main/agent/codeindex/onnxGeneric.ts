/**
 * Generic neural ONNX embedder.
 *
 * Unlike the LightOn path (transformers.js `AutoModel.from_pretrained`, which
 * needs the architecture to be registered), this loads *any* self-contained ONNX
 * graph directly via the underlying ORT `InferenceSession`. That is what makes
 * models with custom architectures — e.g. LiquidAI LFM2.5-Embedding-350M
 * (hybrid conv+attention, bidirectional patches) — usable locally once a user
 * exports the ONNX (see scripts/export-lfm2-embedding-onnx.py).
 *
 * Contract for the exported graph:
 *   inputs : int64 `input_ids`, `attention_mask` (, `token_type_ids`)
 *   output : `last_hidden_state` [batch, seq, hidden] (or `logits`)
 * We CLS-pool (first token) + L2-normalize, matching the LightOn convention.
 */
import { join } from 'path'
import { applyOrtThreadEnvHints, buildOrtSessionOptions, type OrtThreadContext } from './ortSessionOptions'
import { embedBatchedOnnx, type OnnxTokenizer, type OnnxTensorCtor } from './onnxEmbed'
import type { OnnxEmbedSession } from './mdenseon'
import { setCodeIndexRuntimeStatus } from './modelStatus'

function toBigInt64(data: ArrayLike<number | bigint>): BigInt64Array {
  if (data instanceof BigInt64Array) return data
  const out = new BigInt64Array(data.length)
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    out[i] = typeof v === 'bigint' ? v : BigInt(v ?? 0)
  }
  return out
}

/** Minimal ORT surface we rely on (avoids a hard dep on onnxruntime-common types). */
type OrtTensor = { data: ArrayLike<number | bigint>; dims: number[] }
type OrtSession = {
  run(feed: Record<string, unknown>): Promise<Record<string, OrtTensor>>
  release?: () => void
}
type OrtModule = {
  InferenceSession: {
    create(path: string, opts: Record<string, unknown>): Promise<OrtSession>
  }
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown
}

/** Pick the [batch,seq,hidden] (or [batch,hidden]) tensor from ORT outputs. */
function pickHidden(outputs: Record<string, { data: ArrayLike<number | bigint>; dims: number[] }>): {
  data: ArrayLike<number | bigint>
  dims: number[]
} {
  const candidates = Object.values(outputs)
  const threeD = candidates.find((t) => t.dims.length === 3)
  if (threeD) return threeD
  const twoD = candidates.find((t) => t.dims.length === 2)
  if (twoD) return twoD
  if (candidates.length > 0) return candidates[0]!
  throw new Error('ONNX model produced no usable output tensor')
}

export type GenericOnnxOptions = {
  context?: OrtThreadContext
  signal?: AbortSignal
}

/**
 * Load a generic ONNX embedding session from `modelDir/onnx/model_quantized.onnx`.
 * `dimensions` is the known output width (e.g. 1024 for LFM2) used for pooling
 * fallback; the real width is taken from the graph's hidden dim.
 */
export async function loadGenericOnnxSession(
  modelDir: string,
  modelId: string,
  dimensions: number,
  opts: GenericOnnxOptions = {}
): Promise<OnnxEmbedSession> {
  const context = opts.context ?? 'in-process'
  setCodeIndexRuntimeStatus({
    phase: 'loading',
    message: `Loading ONNX session (${context})`,
    modelDir,
    modelId,
    error: null
  })
  applyOrtThreadEnvHints(context === 'utility' ? undefined : 1)
  const transformers = await import('@huggingface/transformers')
  const { env, AutoTokenizer } = transformers as typeof transformers & {
    Tensor?: OnnxTensorCtor
  }
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.useBrowserCache = false
  ;(env as { cacheDir?: string }).cacheDir = modelDir

  const tokenizer = await AutoTokenizer.from_pretrained(modelDir, { local_files_only: true })
  const ort = (env as unknown as { ort: OrtModule }).ort
  const onnxPath = join(modelDir, 'onnx', 'model_quantized.onnx')
  const session = await ort.InferenceSession.create(onnxPath, {
    executionProviders: ['cpu'],
    ...buildOrtSessionOptions(undefined, context)
  })

  const Tensor = (env as { Tensor?: OnnxTensorCtor }).Tensor

  async function modelFn(inputs: unknown): Promise<{
    last_hidden_state?: { data: ArrayLike<number>; dims: number[] }
    logits?: { data: ArrayLike<number>; dims: number[] }
  }> {
    const tok = inputs as {
      input_ids: { data: ArrayLike<number | bigint>; dims: number[] }
      attention_mask?: { data: ArrayLike<number | bigint>; dims: number[] }
      token_type_ids?: { data: ArrayLike<number | bigint>; dims: number[] }
    }
    const feed: Record<string, unknown> = {
      input_ids: new ort.Tensor('int64', toBigInt64(tok.input_ids.data), tok.input_ids.dims)
    }
    if (tok.attention_mask) {
      feed.attention_mask = new ort.Tensor(
        'int64',
        toBigInt64(tok.attention_mask.data),
        tok.attention_mask.dims
      )
    }
    if (tok.token_type_ids) {
      feed.token_type_ids = new ort.Tensor(
        'int64',
        toBigInt64(tok.token_type_ids.data),
        tok.token_type_ids.dims
      )
    }
    const outputs = (await session.run(feed)) as Record<
      string,
      { data: ArrayLike<number | bigint>; dims: number[] }
    >
    const hidden = pickHidden(outputs)
    return { last_hidden_state: { data: hidden.data as ArrayLike<number>, dims: hidden.dims } }
  }

  return {
    modelId,
    dimensions,
    async embed(texts: string[], role: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> {
      return embedBatchedOnnx({
        tokenizer: tokenizer as unknown as OnnxTokenizer,
        model: modelFn,
        texts,
        role,
        signal,
        hiddenSize: dimensions,
        ...(Tensor ? { Tensor } : {})
      })
    },
    dispose: () => {
      try {
        ;(session as { release?: () => void }).release?.()
      } catch {
        /* ignore */
      }
    }
  }
}
