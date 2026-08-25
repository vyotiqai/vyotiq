/**
 * Production runner loader for the in-app Qwen3-ASR ONNX engine.
 * Dynamically imports `onnxruntime-web` so the pure orchestration core
 * (qwen3AsrOrt.ts) stays testable without ONNX.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  applyOrtThreadEnvHints,
  buildOrtSessionOptions,
  resolveOrtIntraOpThreads
} from '../agent/codeindex/ortSessionOptions'
import { dictationCatalogEntry } from '../../shared/dictation'
import type { Tensor as OrtTensor } from 'onnxruntime-node'
import type { Qwen3AsrOnnxConfig, Qwen3AsrRunners } from './qwen3AsrOrt'

function fp16ToFp32(value: number): number {
  const s = (value & 0x8000) >> 15
  const e = (value & 0x7c00) >> 10
  const f = value & 0x03ff
  if (e === 0) {
    return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024)
  }
  if (e === 0x1f) {
    return f ? NaN : (s ? -1 : 1) * Infinity
  }
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024)
}

function loadEmbeddings(dir: string, vocabSize: number, hiddenSize: number): Float32Array {
  const path = join(dir, 'embed_tokens.bin')
  if (!existsSync(path)) {
    throw new Error('Qwen3-ASR model is missing embed_tokens.bin')
  }
  const buf = readFileSync(path)
  const u16 = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
  if (u16.length !== vocabSize * hiddenSize) {
    throw new Error(
      `embed_tokens.bin size ${u16.length} does not match vocab ${vocabSize} x hidden ${hiddenSize}`
    )
  }
  const out = new Float32Array(u16.length)
  for (let i = 0; i < u16.length; i++) out[i] = fp16ToFp32(u16[i]!)
  return out
}

function pickOutput(
  results: Record<string, { data: Float32Array; dims: number[] }>,
  patterns: RegExp | RegExp[]
): { data: Float32Array; dims: number[] } {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  for (const key of Object.keys(results)) {
    if (list.some((p) => p.test(key))) return results[key]!
  }
  const first = Object.values(results)[0]
  if (!first) throw new Error('Qwen3-ASR ONNX graph returned no outputs')
  return first
}

const runnerCache = new Map<string, Promise<Qwen3AsrRunners>>()

export async function createQwen3AsrOnnxRunnersFromOrt(modelDir: string): Promise<Qwen3AsrRunners> {
  const cached = runnerCache.get(modelDir)
  if (cached) return cached
  const promise = buildRunners(modelDir)
  runnerCache.set(modelDir, promise)
  try {
    return await promise
  } catch (err) {
    runnerCache.delete(modelDir)
    throw err
  }
}

async function buildRunners(modelDir: string): Promise<Qwen3AsrRunners> {
  const intra = resolveOrtIntraOpThreads(undefined, 'utility')
  applyOrtThreadEnvHints(intra)
  const ort = (await import('onnxruntime-node')) as typeof import('onnxruntime-node')
  const transformers = await import('@huggingface/transformers')

  const configPath = join(modelDir, 'config.json')
  if (!existsSync(configPath)) throw new Error('Qwen3-ASR model is missing config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Qwen3AsrOnnxConfig

  const hidden = config.encoder.output_dim
  const vocab = config.decoder.vocab_size
  const embeddings = loadEmbeddings(modelDir, vocab, hidden)

  const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelDir, {
    local_files_only: true
  })

  const sessionOpts = buildOrtSessionOptions(undefined, 'utility')
  const encoder = await ort.InferenceSession.create(join(modelDir, 'encoder.onnx'), sessionOpts)
  const decoderInit = await ort.InferenceSession.create(join(modelDir, 'decoder_init.onnx'), sessionOpts)
  const decoderStep = await ort.InferenceSession.create(join(modelDir, 'decoder_step.onnx'), sessionOpts)

  const toBigInt64 = (arr: Int32Array | number[]): BigInt64Array => {
    const out = new BigInt64Array(arr.length)
    for (let i = 0; i < arr.length; i++) out[i] = BigInt(arr[i]!)
    return out
  }

  return {
    async encodeMel(mel) {
      const t = new ort.Tensor('float32', mel, [1, config.mel.n_mels, mel.length / config.mel.n_mels])
      const res = await encoder.run({ mel: t })
      const out = pickOutput(res as unknown as Record<string, { data: Float32Array; dims: number[] }>, /audio_features|logits/)
      return out.data
    },
    async decoderInit(inputIds, audioFeatures, audioOffset) {
      const n = audioFeatures.length / hidden
      const feeds = {
        input_ids: new ort.Tensor('int64', toBigInt64(inputIds), [1, inputIds.length]),
        audio_features: new ort.Tensor('float32', audioFeatures, [1, n, hidden]),
        audio_offset: new ort.Tensor('int64', toBigInt64([audioOffset]), [])
      }
      const res = await decoderInit.run(feeds)
      const r = res as unknown as Record<string, { data: Float32Array; dims: number[] }>
      return {
        logits: pickOutput(r, /logits/).data,
        pastKeys: res[pickOutputName(res, /past_keys|key/i)]!,
        pastValues: res[pickOutputName(res, /past_values|value/i)]!
      }
    },
    async decoderStep(inputEmbeds, positionId, pastKeys, pastValues) {
      const feeds = {
        input_embeds: new ort.Tensor('float32', inputEmbeds, [1, 1, hidden]),
        position_ids: new ort.Tensor('int64', toBigInt64([positionId]), [1, 1]),
        past_keys: pastKeys as unknown as OrtTensor,
        past_values: pastValues as unknown as OrtTensor
      }
      const res = await decoderStep.run(feeds)
      const r = res as unknown as Record<string, { data: Float32Array; dims: number[] }>
      return {
        logits: pickOutput(r, /logits/).data,
        pastKeys: res[pickOutputName(res, /past_keys|key/i)]!,
        pastValues: res[pickOutputName(res, /past_values|value/i)]!
      }
    },
    embed(tokenId) {
      const row = new Float32Array(hidden)
      const base = tokenId * hidden
      for (let i = 0; i < hidden; i++) row[i] = embeddings[base + i]!
      return row
    },
    encodeText(text) {
      return tokenizer.encode(text, { add_special_tokens: false }) as number[]
    },
    decodeTokens(ids) {
      return tokenizer.decode(ids, { skip_special_tokens: false }) as string
    }
  }
}

function pickOutputName(
  res: Record<string, unknown>,
  patterns: RegExp
): string {
  for (const key of Object.keys(res)) {
    if (patterns.test(key)) return key
  }
  return Object.keys(res)[0]!
}

/** Convenience: load config for a catalog model id (used by status/UI). */
export function readQwen3AsrConfig(modelDir: string): Qwen3AsrOnnxConfig | null {
  const p = join(modelDir, 'config.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Qwen3AsrOnnxConfig
  } catch {
    return null
  }
}
