import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeCodeIndex,
  downloadModelFiles,
  getOrOpenCodeIndex,
  modelFilesPresent,
  denseOnOnnxFiles,
  setCodeIndexModelsRootOverrideForTests,
  clearMDenseOnSessionForTests,
  clearEmbedderFailCacheForTests,
  setEmbedderFailCacheTtlMsForTests,
  ensureMDenseOnModel,
  resolveEmbedderForTests,
  LIGHTON_DENSE_DIM
} from '@main/agent/codeindex'
import { resetCodeIndexRuntimeStatusForTests } from '@main/agent/codeindex/modelStatus'
import {
  MDENSEON_MODEL_ID,
  DENSEON_ONNX_MODEL_ID,
  DEFAULT_MODEL_ID,
  LIGHTON_DENSE_DIM as DIM
} from '@main/agent/codeindex/types'

describe('codeindex mDenseOn download + resolve', () => {
  let dir: string
  let modelsRoot: string

  afterEach(() => {
    clearMDenseOnSessionForTests()
    clearEmbedderFailCacheForTests()
    resetCodeIndexRuntimeStatusForTests()
    setCodeIndexModelsRootOverrideForTests(null)
    if (dir) {
      closeCodeIndex(dir)
      rmSync(dir, { recursive: true, force: true })
    }
    if (modelsRoot) {
      rmSync(modelsRoot, { recursive: true, force: true })
    }
  })

  it('downloadModelFiles skips when all files present', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-mdl-'))
    const modelDir = join(modelsRoot, 'DenseOn-onnx-int8')
    mkdirSync(join(modelDir, 'onnx'), { recursive: true })
    for (const f of denseOnOnnxFiles()) {
      writeFileSync(join(modelDir, f.relativePath), 'x', 'utf8')
    }
    expect(modelFilesPresent(modelDir, denseOnOnnxFiles())).toBe(true)
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const ok = await downloadModelFiles(modelDir, denseOnOnnxFiles(), { fetchImpl })
    expect(ok).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('downloadModelFiles fetches missing files', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-mdl-dl-'))
    const modelDir = join(modelsRoot, 'art')
    mkdirSync(modelDir, { recursive: true })
    const files = [
      { relativePath: 'config.json', url: 'https://example.test/config.json' },
      { relativePath: 'onnx/model_quantized.onnx', url: 'https://example.test/model.onnx' }
    ]
    const fetchImpl = vi.fn(async (url: string) => {
      const body = url.includes('model') ? 'onnx-bytes' : '{"ok":true}'
      return {
        ok: true,
        headers: { get: () => String(body.length) },
        body: ReadableStreamFrom(body)
      }
    }) as unknown as typeof fetch

    const ok = await downloadModelFiles(modelDir, files, { fetchImpl })
    expect(ok).toBe(true)
    expect(existsSync(join(modelDir, 'config.json'))).toBe(true)
    expect(existsSync(join(modelDir, 'onnx/model_quantized.onnx'))).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('downloadModelFiles rejects path traversal', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-mdl-trav-'))
    const modelDir = join(modelsRoot, 'art')
    mkdirSync(modelDir, { recursive: true })
    const ok = await downloadModelFiles(
      modelDir,
      [{ relativePath: '../escape.json', url: 'https://example.test/x' }],
      { fetchImpl: vi.fn() as unknown as typeof fetch }
    )
    expect(ok).toBe(false)
  })

  it('ensureMDenseOnModel uses injected createSession and skips network', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-mdl-sess-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    const session = {
      modelId: MDENSEON_MODEL_ID,
      dimensions: DIM,
      async embed(texts: string[]) {
        return texts.map(() => {
          const v = new Float32Array(DIM)
          v[0] = 1
          return v
        })
      }
    }
    const out = await ensureMDenseOnModel({
      createSession: async () => session
    })
    expect(out?.modelId).toBe(MDENSEON_MODEL_ID)
    const [vec] = await out!.embed(['query: hello'], 'query')
    expect(vec!.length).toBe(DIM)
  })

  it('resolveEmbedder defers ONNX ensure until embed()', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-md-fb-'))
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-mdl-empty-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')

    let ensureCalls = 0
    const resolved = await resolveEmbedderForTests({
      embedderId: 'mdenseon',
      autoDownload: false,
      mdenseon: {
        createSession: async () => {
          ensureCalls++
          throw new Error('no session')
        }
      }
    })
    expect(resolved.usedFallback).toBe(false)
    expect(resolved.embedder.modelId).toBe(MDENSEON_MODEL_ID)
    expect(ensureCalls).toBe(0)
    await expect(resolved.embedder.embed(['hello'])).rejects.toThrow()
    expect(ensureCalls).toBe(1)

    const fallback = await resolveEmbedderForTests({
      embedderId: 'mdenseon',
      autoDownload: false,
      mdenseon: {
        createSession: async () => {
          ensureCalls++
          throw new Error('no session')
        }
      }
    })
    expect(fallback.usedFallback).toBe(true)
    expect(fallback.embedder.modelId).toBe(DEFAULT_MODEL_ID)
    expect(ensureCalls).toBe(1)
    closeCodeIndex(dir)
  })

  it('does not retry failed ONNX ensure within fail-cache TTL', async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-mdl-neg-'))
    setCodeIndexModelsRootOverrideForTests(modelsRoot)
    setEmbedderFailCacheTtlMsForTests(60_000)
    let ensureCalls = 0
    const mdenseon = {
      createSession: async () => {
        ensureCalls++
        throw new Error('ort fail')
      }
    }
    const first = await resolveEmbedderForTests({
      embedderId: 'mdenseon',
      autoDownload: false,
      mdenseon
    })
    expect(first.usedFallback).toBe(false)
    await expect(first.embedder.embed(['probe'])).rejects.toThrow('ort fail')
    expect(ensureCalls).toBe(1)
    const second = await resolveEmbedderForTests({
      embedderId: 'mdenseon',
      autoDownload: false,
      mdenseon
    })
    expect(second.usedFallback).toBe(true)
    expect(second.embedder.modelId).toBe(DEFAULT_MODEL_ID)
    expect(ensureCalls).toBe(1)
    clearMDenseOnSessionForTests()
    const third = await resolveEmbedderForTests({
      embedderId: 'mdenseon',
      autoDownload: false,
      mdenseon
    })
    expect(third.usedFallback).toBe(false)
    await expect(third.embedder.embed(['probe'])).rejects.toThrow('ort fail')
    expect(ensureCalls).toBe(2)
  })

  it('embedderId hash forces local-hash', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-hash-force-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    const entry = await getOrOpenCodeIndex(dir, { embedderId: 'hash' })
    expect(entry.embedder.modelId).toBe(DEFAULT_MODEL_ID)
    expect(entry.embedder.dimensions).toBe(384)
    closeCodeIndex(dir)
  })

  it('mock LightOn session embeds with query/document roles', async () => {
    const roles: string[] = []
    const session = {
      modelId: DENSEON_ONNX_MODEL_ID,
      dimensions: LIGHTON_DENSE_DIM,
      async embed(texts: string[], role: 'query' | 'document') {
        roles.push(role)
        return texts.map(() => {
          const v = new Float32Array(LIGHTON_DENSE_DIM)
          v[role === 'query' ? 0 : 1] = 1
          return v
        })
      }
    }
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-roles-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'auth.ts'),
      'export function validateAuthToken(t: string) { return t.length > 0 }\n',
      'utf8'
    )
    const entry = await getOrOpenCodeIndex(dir, {
      embedder: {
        modelId: session.modelId,
        dimensions: session.dimensions,
        embed: (texts, opts) => session.embed(texts, opts?.role ?? 'document')
      }
    })
    await entry.embedder.embed(['doc'], { role: 'document' })
    await entry.embedder.embed(['q'], { role: 'query' })
    expect(roles).toEqual(['document', 'query'])
    closeCodeIndex(dir)
  })
})

function ReadableStreamFrom(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc)
      controller.close()
    }
  })
}
