import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { setCodeIndexRuntimeStatus } from './modelStatus'

const DOWNLOAD_STATUS_THROTTLE_MS = 75
let lastDownloadStatusAt = 0

function publishDownloadStatus(partial: Parameters<typeof setCodeIndexRuntimeStatus>[0]): void {
  const now = Date.now()
  const force =
    partial.phase === 'error' ||
    partial.phase === 'ready' ||
    (typeof partial.progress === 'number' && partial.progress >= 0.99)
  if (!force && now - lastDownloadStatusAt < DOWNLOAD_STATUS_THROTTLE_MS) return
  lastDownloadStatusAt = now
  setCodeIndexRuntimeStatus(partial)
}

export type DownloadFileSpec = {
  /** Relative path under model dir (e.g. onnx/model_quantized.onnx). */
  relativePath: string
  url: string
}

export type DownloadProgress = {
  file: string
  received: number
  total: number | null
  overallProgress: number
}

function hfResolve(repo: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${path}`
}

/** DenseOn INT8 ONNX bootstrap (public; ~150MB). */
export function denseOnOnnxFiles(repo = 'onnx-community/DenseOn-ONNX'): DownloadFileSpec[] {
  const files = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx'
  ]
  return files.map((relativePath) => ({
    relativePath,
    url: hfResolve(repo, relativePath)
  }))
}

/** Preferred mDenseOn files when an ONNX export exists on the hub. */
export function mDenseOnOnnxFiles(repo = 'lightonai/mDenseOn'): DownloadFileSpec[] {
  return [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'config_sentence_transformers.json',
    'onnx/model_quantized.onnx'
  ].map((relativePath) => ({
    relativePath,
    url: hfResolve(repo, relativePath)
  }))
}

export function modelFilesPresent(modelDir: string, files: DownloadFileSpec[]): boolean {
  return files.every((f) => {
    const p = join(modelDir, f.relativePath)
    if (!existsSync(p)) return false
    try {
      return statSync(p).size > 0
    } catch {
      return false
    }
  })
}

/** Resolve dest under modelDir; reject path traversal. */
export function resolveModelFilePath(modelDir: string, relativePath: string): string {
  const root = resolve(modelDir)
  const dest = resolve(root, relativePath)
  const prefix = root.endsWith(sep) ? root : root + sep
  if (dest !== root && !dest.startsWith(prefix)) {
    throw new Error(`Refusing path outside model dir: ${relativePath}`)
  }
  return dest
}

async function downloadOne(
  url: string,
  dest: string,
  onChunk: (received: number, total: number | null) => void,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  try {
    if (existsSync(partial)) unlinkSync(partial)
  } catch {
    /* ignore */
  }
  const res = await fetchImpl(url, { signal, redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`Download failed HTTP ${res.status} for ${url}`)
  }
  const totalHeader = res.headers.get('content-length')
  const total = totalHeader ? Number(totalHeader) : null
  if (!res.body) throw new Error(`Download missing body for ${url}`)
  const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
  let received = 0
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length
    onChunk(received, total && Number.isFinite(total) ? total : null)
  })
  await pipeline(nodeStream, createWriteStream(partial))
  renameSync(partial, dest)
}

/**
 * Download model artifacts into `modelDir`. Skips files that already exist.
 * Returns false if any required file could not be fetched.
 * Soft-fail: does not leave sticky `phase: error` (caller may try next artifact).
 */
export async function downloadModelFiles(
  modelDir: string,
  files: DownloadFileSpec[],
  opts: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    onProgress?: (p: DownloadProgress) => void
    /** When true, set phase=error on failure (default false — soft for artifact fallback). */
    hardError?: boolean
  } = {}
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch
  mkdirSync(modelDir, { recursive: true })
  if (modelFilesPresent(modelDir, files)) return true

  const missing = files.filter((f) => {
    try {
      return !existsSync(resolveModelFilePath(modelDir, f.relativePath))
    } catch {
      return true
    }
  })
  let completedFiles = files.length - missing.length

  for (let i = 0; i < missing.length; i++) {
    const spec = missing[i]!
    let dest: string
    try {
      dest = resolveModelFilePath(modelDir, spec.relativePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (opts.hardError) {
        setCodeIndexRuntimeStatus({
          phase: 'error',
          error: msg,
          message: `Failed: ${spec.relativePath}`
        })
      } else {
        setCodeIndexRuntimeStatus({
          phase: 'downloading',
          error: null,
          message: `Skip invalid path ${spec.relativePath}`
        })
      }
      return false
    }
    try {
      await downloadOne(
        spec.url,
        dest,
        (received, total) => {
          const fileFrac = total && total > 0 ? received / total : 0
          const progress = Math.min(0.99, (completedFiles + fileFrac) / files.length)
          opts.onProgress?.({
            file: spec.relativePath,
            received,
            total,
            overallProgress: progress
          })
          publishDownloadStatus({
            phase: 'downloading',
            progress,
            error: null,
            message: `Downloading ${spec.relativePath}`,
            indexProgress: null
          })
        },
        fetchImpl,
        opts.signal
      )
      completedFiles++
    } catch (err) {
      try {
        if (existsSync(`${dest}.partial`)) unlinkSync(`${dest}.partial`)
      } catch {
        /* ignore */
      }
      const msg = err instanceof Error ? err.message : String(err)
      if (opts.hardError) {
        setCodeIndexRuntimeStatus({
          phase: 'error',
          error: msg,
          message: `Failed: ${spec.relativePath}`
        })
      } else {
        setCodeIndexRuntimeStatus({
          phase: 'downloading',
          error: null,
          message: `Unavailable: ${spec.relativePath}`
        })
      }
      return false
    }
  }
  return modelFilesPresent(modelDir, files)
}
