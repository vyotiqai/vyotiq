export type ChunkKind = 'function' | 'class' | 'method' | 'module' | 'section' | 'block'
export type CodeChunk = {
  /** Workspace-relative path with forward slashes. */
  path: string
  startLine: number
  endLine: number
  kind: ChunkKind
  name: string
  parentName?: string
  /** Raw source for the line range. */
  text: string
  /** Text embedded (path + parent + body). */
  contextualizedText: string
}

export type StoredChunk = {
  id: number
  path: string
  startLine: number
  endLine: number
  kind: ChunkKind
  name: string
  parentName: string | null
  chunkHash: string
}

export type CodebaseSearchMode = 'hybrid' | 'semantic' | 'lexical'

export type CodebaseSearchHit = {
  path: string
  startLine: number
  endLine: number
  kind: ChunkKind
  name: string
  parentName: string | null
  score: number
  snippet: string
}

export type IndexStatus = {
  ready: boolean
  modelId: string
  fileCount: number
  chunkCount: number
  lastIndexedAt: string | null
}

export const DEFAULT_EMBED_DIM = 384
export const DEFAULT_MODEL_ID = 'local-hash-v1'

/** True for the bag-of-tokens fallback — not a dense neural embedder. */
export function isHashEmbedderModelId(modelId: string): boolean {
  return modelId === DEFAULT_MODEL_ID || modelId.startsWith('local-hash')
}

/**
 * Transient ONNX/Ollama failure must not re-embed a healthy neural index with
 * hash vectors. Empty stores may still be filled with hash so search works.
 */
export function shouldPreserveIndexedEmbeddings(opts: {
  usedFallback: boolean
  storeModelId: string | null | undefined
  storeChunkCount: number
}): boolean {
  if (!opts.usedFallback) return false
  if (opts.storeChunkCount <= 0) return false
  const id = opts.storeModelId?.trim()
  if (!id) return false
  return !isHashEmbedderModelId(id)
}

/** Preferred LightOn mDenseOn ONNX identity (when weights exist). */
export const MDENSEON_MODEL_ID = 'lightonai/mDenseOn@onnx-int8'
/** Bootstrap INT8 ONNX until mDenseOn ONNX is published (same Dense family). */
export const DENSEON_ONNX_MODEL_ID = 'onnx-community/DenseOn@onnx-int8'
/** Older label written to stores before the id was aligned with the download repo. */
export const DENSEON_ONNX_MODEL_ID_LEGACY = 'lightonai/DenseOn@onnx-int8'

/** LiquidAI LFM2.5-Embedding-350M — dense bi-encoder, 1024-dim CLS, 11 languages. */
export const LFM2_EMBEDDING_MODEL_ID = 'liquidai/LFM2.5-Embedding-350M@onnx'
export const LFM2_EMBEDDING_DIM = 1024
/** Ollama/llama.cpp model tag for the LFM2.5-Embedding GGUF (local, no export needed).
 *  Uses the hf.co/ form so Ollama pulls straight from the Hugging Face GGUF repo,
 *  independent of Ollama's curated-library naming. */
export const LFM2_OLLAMA_MODEL = 'hf.co/LiquidAI/LFM2.5-Embedding-350M-GGUF'

/**
 * Neural dense ONNX models are grouped into families that share an embedding
 * space. Two model ids are compatible when they are the same id OR belong to
 * the same family (e.g. lazy mDenseOn vs stored DenseOn-ONNX, both LightOn).
 * LFM2 is its own family and is incompatible with LightOn (different dim / space).
 */
const NEURAL_MODEL_FAMILY: Record<string, string> = {
  [MDENSEON_MODEL_ID]: 'lighton',
  [DENSEON_ONNX_MODEL_ID]: 'lighton',
  [DENSEON_ONNX_MODEL_ID_LEGACY]: 'lighton',
  [LFM2_EMBEDDING_MODEL_ID]: 'lfm2'
}

/** Family key for a known neural dense ONNX model id, or null for unknowns. */
export function neuralModelFamily(modelId: string): string | null {
  return NEURAL_MODEL_FAMILY[modelId] ?? null
}

/** True for any neural dense ONNX embedder (LightOn or LFM2 families). */
export function isNeuralDenseModelId(modelId: string): boolean {
  return neuralModelFamily(modelId) != null
}

/** Lazy embedder may report mDenseOn before DenseOn-ONNX actually loads. */
export function isLightOnDenseModelId(modelId: string): boolean {
  return neuralModelFamily(modelId) === 'lighton'
}

/** Same embedding space — same id or same neural family (LFM2 / LightOn). */
export function denseModelIdsCompatible(storeModelId: string, embedderModelId: string): boolean {
  if (storeModelId === embedderModelId) return true
  const a = neuralModelFamily(storeModelId)
  const b = neuralModelFamily(embedderModelId)
  return a != null && a === b
}

export const LIGHTON_DENSE_DIM = 768
export const RRF_K = 60
export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_LIMIT = 40
/** Soft cap on characters per chunk body before split. */
export const MAX_CHUNK_CHARS = 2400
/** Dense index skips files larger than this; snippet reads use the same cap. */
export const CODE_INDEX_MAX_FILE_BYTES = 512 * 1024

export type {
  CodeIndexEmbedderSetting as CodeIndexEmbedderId,
  CodeIndexModelPhase,
  CodeIndexRuntimeStatus
} from '../../../shared/ipc/schemas/settings'

