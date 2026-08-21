import { fetchWithRetry } from '../fetchWithRetry'
import { formatProviderHttpError } from '../httpErrors'
import { normalizeCustomOpenAiBaseUrl } from '../../../../shared/domain/providers'
import { editsUrl, generationsUrl, rememberCustomImageHttpResult } from './customProbe'
import { mimeForOutputFormat } from './mime'
import { validateOpenAiImageSize } from './openaiSize'
import { MAX_OPENAI_EDIT_IMAGES } from './workspaceImages'
import type {
  ImageEditRequest,
  ImageGenAdapter,
  ImageGenProviderId,
  ImageGenRequest,
  ImageGenResult
} from './types'

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1'
const MAX_N = 4

export type OpenAiImageAdapterOptions = {
  /** OpenAI-compatible root ending in `/v1`. */
  baseUrl?: string
  /** Adapter identity (`openai` | `custom`). */
  providerId?: Extract<ImageGenProviderId, 'openai' | 'custom'>
  /**
   * When true, skip gpt-image-2-only client rejects (transparent bg) and use
   * looser size checks suitable for DALL·E-style clones.
   */
  compatMode?: boolean
}

function parseSize(size: string | undefined): { width?: number; height?: number } {
  if (!size || size === 'auto') return {}
  const m = /^(\d+)x(\d+)$/i.exec(size.trim())
  if (!m) return {}
  return { width: Number(m[1]), height: Number(m[2]) }
}

function isGptImage2(model: string): boolean {
  return model.toLowerCase().includes('gpt-image-2')
}

function resolveBaseUrl(req: ImageGenRequest, opts?: OpenAiImageAdapterOptions): string {
  const fromReq = req.openAiBaseUrl?.trim()
  if (fromReq) return normalizeCustomOpenAiBaseUrl(fromReq)
  if (opts?.baseUrl?.trim()) return normalizeCustomOpenAiBaseUrl(opts.baseUrl)
  return DEFAULT_OPENAI_BASE
}

function isCompat(req: ImageGenRequest, opts?: OpenAiImageAdapterOptions): boolean {
  return Boolean(req.openAiCompatMode || opts?.compatMode)
}

function validateOpenAiRequest(
  req: ImageGenRequest,
  opts?: OpenAiImageAdapterOptions
): ImageGenResult | null {
  const compat = isCompat(req, opts)
  const sizeCheck = validateOpenAiImageSize(req.size, {
    model: compat && !isGptImage2(req.model) ? 'dall-e-3' : req.model
  })
  if (!sizeCheck.ok) return { ok: false, error: sizeCheck.error }

  if (!compat && req.background === 'transparent' && isGptImage2(req.model)) {
    return {
      ok: false,
      error:
        'gpt-image-2 does not support background: transparent. Use opaque/auto, or an older GPT Image model that supports transparency.'
    }
  }

  if (
    req.outputCompression != null &&
    (req.outputFormat === 'png' || req.outputFormat == null)
  ) {
    if (req.outputFormat === 'png') {
      return {
        ok: false,
        error: 'output_compression requires output_format jpeg or webp.'
      }
    }
  }

  if (req.background === 'transparent' && req.outputFormat === 'jpeg') {
    return {
      ok: false,
      error: 'background: transparent requires output_format png or webp (not jpeg).'
    }
  }

  return null
}

export function mapOpenAiImageError(
  status: number,
  body: string,
  label = 'OpenAI'
): ImageGenResult {
  let code: string | undefined
  let message = formatProviderHttpError(
    status,
    body,
    label === 'OpenAI' ? 'openai' : undefined
  )
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; type?: string; message?: string }
    }
    if (typeof parsed.error?.code === 'string') code = parsed.error.code
    if (status === 401) {
      message =
        label === 'OpenAI'
          ? 'OpenAI authentication failed (HTTP 401). Update your API key in Settings → Providers.'
          : `${label} authentication failed (HTTP 401). Check the Custom API key in Settings → Providers.`
      code = code ?? 'invalid_api_key'
    } else if (code === 'moderation_blocked') {
      message =
        `${label} blocked this image prompt (moderation). Revise the prompt; do not retry the same request.`
    } else if (
      label === 'OpenAI' &&
      (parsed.error?.type === 'image_generation_user_error' ||
        /organization.*(verif|must be verified)/i.test(message))
    ) {
      message =
        message.includes('verif') || /organization/i.test(message)
          ? 'OpenAI GPT Image requires organization verification. Verify at https://platform.openai.com/settings/organization/general then retry.'
          : message
    } else if (status === 404 || status === 501) {
      message =
        label === 'OpenAI'
          ? message
          : `${label} host returned HTTP ${status} for Images. The custom OpenAI-compatible base URL likely has no /v1/images/generations. Disable “Enable image generation on custom host” or fix the host.`
      code = code ?? 'images_unsupported'
    }
  } catch {
    if (status === 401) {
      message =
        label === 'OpenAI'
          ? 'OpenAI authentication failed (HTTP 401). Update your API key in Settings → Providers.'
          : `${label} authentication failed (HTTP 401). Check the Custom API key in Settings → Providers.`
    } else if (status === 404 || status === 501) {
      if (label !== 'OpenAI') {
        message = `${label} host returned HTTP ${status} for Images. No OpenAI Images API on this base URL.`
        code = 'images_unsupported'
      }
    }
  }
  return { ok: false, error: message, code }
}

function parseOpenAiImageResponse(
  text: string,
  opts: {
    size?: string
    outputFormat?: ImageGenRequest['outputFormat']
    experimentalSize?: boolean
  }
): ImageGenResult {
  let parsed: {
    data?: Array<{ b64_json?: string; revised_prompt?: string; url?: string }>
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { ok: false, error: 'OpenAI Images returned invalid JSON' }
  }

  const entries = parsed.data ?? []
  const decoded: Array<{ bytes: Buffer; revisedPrompt?: string }> = []
  for (const entry of entries) {
    const b64 = entry?.b64_json
    if (!b64) continue
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.length === 0) continue
    decoded.push({
      bytes,
      revisedPrompt: typeof entry.revised_prompt === 'string' ? entry.revised_prompt : undefined
    })
  }

  if (decoded.length === 0) {
    const hasUrlOnly = entries.some((e) => typeof e?.url === 'string' && e.url.length > 0)
    return {
      ok: false,
      error: hasUrlOnly
        ? 'Images response returned URL-only data; request response_format b64_json (VYOTIQ does not download temporary URLs).'
        : 'OpenAI Images response did not include image data'
    }
  }

  const mimeType = mimeForOutputFormat(opts.outputFormat)
  const dims = parseSize(opts.size)
  const first = decoded[0]!
  return {
    ok: true,
    bytes: first.bytes,
    mimeType,
    additionalImages:
      decoded.length > 1
        ? decoded.slice(1).map((d) => ({ bytes: d.bytes, mimeType }))
        : undefined,
    revisedPrompt: first.revisedPrompt,
    moderationPassed: true,
    experimentalSize: opts.experimentalSize,
    ...dims
  }
}

function blobFromImage(bytes: Buffer, mimeType: string, _filename: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type: mimeType || 'application/octet-stream' })
}

function clampN(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return 1
  return Math.min(MAX_N, Math.max(1, Math.floor(n)))
}

function appendSharedOpenAiFields(
  body: Record<string, unknown> | FormData,
  req: ImageGenRequest,
  asForm: boolean
): void {
  const n = clampN(req.n)
  if (asForm) {
    const form = body as FormData
    form.append('n', String(n))
    if (req.size) form.append('size', req.size)
    if (req.quality) form.append('quality', req.quality)
    if (req.outputFormat) form.append('output_format', req.outputFormat)
    if (req.outputCompression != null && req.outputFormat && req.outputFormat !== 'png') {
      form.append('output_compression', String(req.outputCompression))
    }
    if (req.background) form.append('background', req.background)
  } else {
    const json = body as Record<string, unknown>
    json.n = n
    if (req.size) json.size = req.size
    if (req.quality) json.quality = req.quality
    if (req.outputFormat) json.output_format = req.outputFormat
    if (req.outputCompression != null && req.outputFormat && req.outputFormat !== 'png') {
      json.output_compression = req.outputCompression
    }
    if (req.background) json.background = req.background
  }
}

/**
 * Build an OpenAI Images adapter, optionally pointed at a custom `/v1` host.
 */
export function createOpenAiImageAdapter(
  adapterOpts: OpenAiImageAdapterOptions = {}
): ImageGenAdapter {
  const providerId = adapterOpts.providerId ?? 'openai'
  const label = providerId === 'custom' ? 'Custom OpenAI' : 'OpenAI'

  return {
    providerId,
    async generate(apiKey, req: ImageGenRequest): Promise<ImageGenResult> {
      const invalid = validateOpenAiRequest(req, adapterOpts)
      if (invalid) return invalid

      const baseUrl = resolveBaseUrl(req, adapterOpts)
      const sizeCheck = validateOpenAiImageSize(req.size, {
        model: isCompat(req, adapterOpts) && !isGptImage2(req.model) ? 'dall-e-3' : req.model
      })
      const experimentalSize = sizeCheck.ok ? Boolean(sizeCheck.experimental) : false

      const body: Record<string, unknown> = {
        model: req.model,
        prompt: req.prompt,
        response_format: 'b64_json'
      }
      appendSharedOpenAiFields(body, req, false)

      let res: Response
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        }
        if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
        res = await fetchWithRetry(
          generationsUrl(baseUrl),
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: req.signal
          },
          { maxAttempts: 3 }
        )
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `${label} Images request failed: ${msg}` }
      }

      if (providerId === 'custom') {
        rememberCustomImageHttpResult(baseUrl, res.status)
      }

      const text = await res.text()
      if (!res.ok) return mapOpenAiImageError(res.status, text, label)
      return parseOpenAiImageResponse(text, {
        size: req.size,
        outputFormat: req.outputFormat,
        experimentalSize
      })
    },

    async edit(apiKey, req: ImageEditRequest): Promise<ImageGenResult> {
      if (req.images.length === 0) {
        return { ok: false, error: `${label} image edit requires at least one source image` }
      }
      if (req.images.length > MAX_OPENAI_EDIT_IMAGES) {
        return {
          ok: false,
          error: `${label} image edit accepts at most ${MAX_OPENAI_EDIT_IMAGES} images (got ${req.images.length})`
        }
      }

      const invalid = validateOpenAiRequest(req, adapterOpts)
      if (invalid) return invalid

      const baseUrl = resolveBaseUrl(req, adapterOpts)
      const sizeCheck = validateOpenAiImageSize(req.size, {
        model: isCompat(req, adapterOpts) && !isGptImage2(req.model) ? 'dall-e-3' : req.model
      })
      const experimentalSize = sizeCheck.ok ? Boolean(sizeCheck.experimental) : false

      const form = new FormData()
      form.append('model', req.model)
      form.append('prompt', req.prompt)
      form.append('response_format', 'b64_json')
      appendSharedOpenAiFields(form, req, true)

      for (const img of req.images) {
        const blob = blobFromImage(img.bytes, img.mimeType, img.filename)
        form.append('image[]', blob, img.filename || 'image.png')
      }
      if (req.mask) {
        const maskBlob = blobFromImage(req.mask.bytes, req.mask.mimeType, req.mask.filename)
        form.append('mask', maskBlob, req.mask.filename || 'mask.png')
      }

      let res: Response
      try {
        const headers: Record<string, string> = {}
        if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
        res = await fetchWithRetry(
          editsUrl(baseUrl),
          {
            method: 'POST',
            headers,
            body: form,
            signal: req.signal
          },
          { maxAttempts: 3 }
        )
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `${label} Images edit request failed: ${msg}` }
      }

      const text = await res.text()
      if (!res.ok) {
        if (providerId === 'custom' && (res.status === 404 || res.status === 501)) {
          return {
            ok: false,
            error:
              'Custom host does not support OpenAI image edits (`/v1/images/edits`). Generate a new image, or use the first-party OpenAI provider for masked edits.',
            code: 'images_edits_unsupported'
          }
        }
        return mapOpenAiImageError(res.status, text, label)
      }
      return parseOpenAiImageResponse(text, {
        size: req.size,
        outputFormat: req.outputFormat,
        experimentalSize
      })
    }
  }
}

export const openaiImageAdapter: ImageGenAdapter = createOpenAiImageAdapter({
  providerId: 'openai',
  baseUrl: DEFAULT_OPENAI_BASE
})

/** Custom OpenAI-compatible host — base URL comes from the request / settings. */
export const customImageAdapter: ImageGenAdapter = createOpenAiImageAdapter({
  providerId: 'custom',
  compatMode: true
})
