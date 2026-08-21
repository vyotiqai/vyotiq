import { existsSync } from 'fs'
import { isAbortError } from '../../../shared/errors'
import type { Embedder } from './embed'
import {
  denseOnOnnxFiles,
  downloadModelFiles,
  mDenseOnOnnxFiles,
  modelFilesPresent,
  type DownloadFileSpec
} from './modelDownload'
import { codeIndexModelDir } from './modelPaths'
import { setCodeIndexRuntimeStatus } from './modelStatus'
import {
  DENSEON_ONNX_MODEL_ID,
  LIGHTON_DENSE_DIM,
  MDENSEON_MODEL_ID
} from './types'
import { applyOrtThreadEnvHints, buildOrtSessionOptions } from './ortSessionOptions'
import { embedBatchedOnnx, type OnnxTensorCtor, type OnnxTokenizer } from './onnxEmbed'
import {
  canUseUtilityProcess,
  getEmbedUtilityClient,
  setEmbedUtilitySessionLostHandler
} from './embedUtilityClient'

export type MDenseOnEnsureOptions = {
  autoDownload?: boolean
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Injected for tests — skip HF download / ORT. */
  createSession?: (modelDir: string) => Promise<OnnxEmbedSession>
  /** Force in-process ORT (skip utilityProcess). */
  inProcess?: boolean
}

export type OnnxEmbedSession = {
  modelId: string
  dimensions: number
  embed(
    texts: string[],
    role: 'query' | 'document',
    signal?: AbortSignal
  ): Promise<Float32Array[]>
  dispose?: () => void
}

type Artifact = {
  artifactId: string
  modelId: string
  files: DownloadFileSpec[]
  /**
   * When false, never fetch from hub — only use if already on disk.
   * mDenseOn has no public ONNX export yet (2026-08); DenseOn is the bootstrap download.
   */
  allowAutoDownload: boolean
}

const ARTIFACTS: Artifact[] = [
  {
    artifactId: 'mDenseOn-onnx-int8',
    modelId: MDENSEON_MODEL_ID,
    files: mDenseOnOnnxFiles(),
    allowAutoDownload: false
  },
  {
    artifactId: 'DenseOn-onnx-int8',
    modelId: DENSEON_ONNX_MODEL_ID,
    files: denseOnOnnxFiles(),
    allowAutoDownload: true
  }
]

/** True when LightOn ONNX weights are already on disk (no session load). */
export function mDenseOnWeightsOnDisk(): boolean {
  for (const art of ARTIFACTS) {
    if (modelFilesPresent(codeIndexModelDir(art.artifactId), art.files)) return true
  }
  return false
}

let cachedSession: OnnxEmbedSession | null = null
let ensurePromise: Promise<OnnxEmbedSession | null> | null = null

export type EmbedderFailKind = 'mdenseon' | 'ollama'

/** Skip failed ONNX ensure / Ollama probe for this long (search must not retry 120s loads). */
const DEFAULT_EMBEDDER_FAIL_TTL_MS = 5 * 60_000

let embedderFailTtlMs = DEFAULT_EMBEDDER_FAIL_TTL_MS
const embedderFailUntil = new Map<EmbedderFailKind, number>()

export function isEmbedderFailCached(kind: EmbedderFailKind): boolean {
  const until = embedderFailUntil.get(kind)
  if (until == null) return false
  if (Date.now() >= until) {
    embedderFailUntil.delete(kind)
    return false
  }
  return true
}

export function rememberEmbedderFail(kind: EmbedderFailKind): void {
  embedderFailUntil.set(kind, Date.now() + embedderFailTtlMs)
}

export function clearEmbedderFailCache(kind?: EmbedderFailKind): void {
  if (kind == null) {
    embedderFailUntil.clear()
    return
  }
  embedderFailUntil.delete(kind)
}

/** @internal */
export function setEmbedderFailCacheTtlMsForTests(ms: number): void {
  embedderFailTtlMs = Math.max(0, ms)
}

/** @internal */
export function clearEmbedderFailCacheForTests(): void {
  embedderFailUntil.clear()
  embedderFailTtlMs = DEFAULT_EMBEDDER_FAIL_TTL_MS
}

/** Drop cached proxy only — do not kill a healthy utility child. */
export function invalidateMDenseOnSessionCache(): void {
  cachedSession = null
  ensurePromise = null
}

setEmbedUtilitySessionLostHandler(() => {
  invalidateMDenseOnSessionCache()
})

/** Drop cached ONNX session (settings embedder change / tests). */
export function clearMDenseOnSession(): void {
  cachedSession?.dispose?.()
  cachedSession = null
  ensurePromise = null
  clearEmbedderFailCache()
  // Awaitable shutdown — do not null the singleton mid-flight via the test helper.
  void getEmbedUtilityClient().shutdown().catch(() => undefined)
}

/** @deprecated Prefer clearMDenseOnSession */
export const clearMDenseOnSessionForTests = clearMDenseOnSession

/** In-process ORT load (tests / VYOTIQ_EMBED_IN_PROCESS / explicit inProcess). */
export async function loadTransformersSessionInProcess(
  modelDir: string,
  modelId: string
): Promise<OnnxEmbedSession> {
  setCodeIndexRuntimeStatus({
    phase: 'loading',
    message: 'Loading ONNX session',
    modelDir,
    error: null
  })
  applyOrtThreadEnvHints()
  const transformers = await import('@huggingface/transformers')
  const { env, AutoTokenizer, AutoModel, Tensor } = transformers as typeof transformers & {
    Tensor?: OnnxTensorCtor
  }
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.useBrowserCache = false
  ;(env as { cacheDir?: string }).cacheDir = modelDir

  const tokenizer = await AutoTokenizer.from_pretrained(modelDir, { local_files_only: true })
  const model = await AutoModel.from_pretrained(modelDir, {
    local_files_only: true,
    dtype: 'q8',
    session_options: buildOrtSessionOptions()
  })

  return {
    modelId,
    dimensions: LIGHTON_DENSE_DIM,
    async embed(
      texts: string[],
      role: 'query' | 'document',
      signal?: AbortSignal
    ): Promise<Float32Array[]> {
      return embedBatchedOnnx({
        tokenizer: tokenizer as unknown as OnnxTokenizer,
        model: (inputs) => model(inputs),
        texts,
        role,
        signal,
        hiddenSize: LIGHTON_DENSE_DIM,
        ...(Tensor ? { Tensor } : {})
      })
    },
    dispose: () => {
      try {
        ;(model as { dispose?: () => void }).dispose?.()
      } catch {
        /* ignore */
      }
    }
  }
}

async function loadSession(
  modelDir: string,
  modelId: string,
  opts: MDenseOnEnsureOptions
): Promise<OnnxEmbedSession> {
  const preferUtility =
    !opts.inProcess &&
    !opts.createSession &&
    canUseUtilityProcess() &&
    process.env.VYOTIQ_EMBED_IN_PROCESS !== '1'

  if (preferUtility) {
    setCodeIndexRuntimeStatus({
      phase: 'loading',
      message: 'Loading ONNX session (utilityProcess)',
      modelDir,
      error: null
    })
    try {
      const client = getEmbedUtilityClient()
      return await client.ensure({ modelDir, modelId, signal: opts.signal })
    } catch (err) {
      setCodeIndexRuntimeStatus({
        phase: 'error',
        message: 'utilityProcess failed — not loading ONNX in-process',
        modelDir,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  }

  return loadTransformersSessionInProcess(modelDir, modelId)
}

/**
 * Ensure LightOn dense ONNX is on disk and loadable.
 * Uses mDenseOn ONNX when already cached; otherwise downloads DenseOn INT8 bootstrap.
 */
export async function ensureMDenseOnModel(
  opts: MDenseOnEnsureOptions = {}
): Promise<OnnxEmbedSession | null> {
  if (cachedSession) return cachedSession
  if (isEmbedderFailCached('mdenseon')) return null
  if (ensurePromise) return ensurePromise

  ensurePromise = (async () => {
    if (opts.createSession) {
      const dir = codeIndexModelDir('test-mock')
      const session = await opts.createSession(dir)
      cachedSession = session
      setCodeIndexRuntimeStatus({
        phase: 'ready',
        modelId: session.modelId,
        modelDir: dir,
        progress: 1,
        message: 'Ready',
        error: null
      })
      return session
    }

    const autoDownload = opts.autoDownload !== false

    for (const art of ARTIFACTS) {
      const modelDir = codeIndexModelDir(art.artifactId)
      const present = modelFilesPresent(modelDir, art.files)

      if (!present && autoDownload && art.allowAutoDownload) {
        setCodeIndexRuntimeStatus({
          phase: 'downloading',
          modelId: art.modelId,
          modelDir,
          progress: 0,
          message: `Downloading ${art.modelId}`,
          error: null
        })
        const ok = await downloadModelFiles(modelDir, art.files, {
          fetchImpl: opts.fetchImpl,
          signal: opts.signal,
          hardError: false
        })
        if (!ok) continue
      } else if (!present) {
        continue
      }

      if (!existsSync(modelDir)) continue

      try {
        const session = await loadSession(modelDir, art.modelId, opts)
        cachedSession = session
        setCodeIndexRuntimeStatus({
          phase: 'ready',
          modelId: session.modelId,
          modelDir,
          progress: 1,
          message: 'Ready',
          error: null
        })
        return session
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setCodeIndexRuntimeStatus({
          phase: 'error',
          modelId: art.modelId,
          modelDir,
          error: msg,
          message: 'Failed to load ONNX session'
        })
        // Try next artifact.
      }
    }

    setCodeIndexRuntimeStatus({
      phase: 'fallback_hash',
      message: 'LightOn dense ONNX unavailable — using hash',
      progress: null,
      error: null
    })
    return null
  })()

  try {
    const session = await ensurePromise
    if (session) {
      clearEmbedderFailCache('mdenseon')
      return session
    }
    rememberEmbedderFail('mdenseon')
    return null
  } catch (err) {
    if (!isAbortError(err)) {
      rememberEmbedderFail('mdenseon')
    }
    throw err
  } finally {
    ensurePromise = null
  }
}

export type MDenseOnEmbedderOptions = MDenseOnEnsureOptions & {
  /** Force a pre-built session (tests). */
  session?: OnnxEmbedSession
}

/** Embedder wrapping LightOn dense ONNX (mDenseOn or DenseOn bootstrap). */
export function createMDenseOnEmbedder(opts: MDenseOnEmbedderOptions = {}): Embedder {
  let sessionPromise: Promise<OnnxEmbedSession | null> | null = null

  const getSession = async (): Promise<OnnxEmbedSession> => {
    if (opts.session) return opts.session
    if (!sessionPromise) sessionPromise = ensureMDenseOnModel(opts)
    const s = await sessionPromise
    if (!s) throw new Error('LightOn dense ONNX model not available')
    return s
  }

  return {
    get modelId() {
      return opts.session?.modelId ?? cachedSession?.modelId ?? MDENSEON_MODEL_ID
    },
    dimensions: LIGHTON_DENSE_DIM,
    async embed(texts: string[], embedOpts?: { role?: 'query' | 'document'; signal?: AbortSignal }): Promise<Float32Array[]> {
      const role = embedOpts?.role ?? 'document'
      const session = await getSession()
      return session.embed(texts, role, embedOpts?.signal)
    }
  }
}
