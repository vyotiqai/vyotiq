/**
 * OpenRouter dedicated Image API adapter (`POST /api/v1/images`).
 * @see https://openrouter.ai/docs/api/api-reference/images/create-images
 */

import { fetchWithRetry } from '../fetchWithRetry'
import { formatProviderHttpError } from '../httpErrors'
import { mimeForOutputFormat } from './mime'
import {
  lookupOpenRouterImageModel,
  openRouterImageRequestHeaders
} from './openrouterDiscovery'
import type {
  ImageEditRequest,
  ImageGenAdapter,
  ImageGenRequest,
  ImageGenResult,
  ImageOutputFormat
} from './types'

const OPENROUTER_IMAGES_URL = 'https://openrouter.ai/api/v1/images'
const MAX_N = 4

function clampN(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return 1
  return Math.min(MAX_N, Math.max(1, Math.floor(n)))
}

function normalizeResolution(resolution: string | undefined): string | undefined {
  if (!resolution?.trim()) return undefined
  const r = resolution.trim().replace(/\s+/g, '')
  const lower = r.toLowerCase()
  // OpenRouter tiers are often 512 / 1K / 2K / 4K (case-sensitive in docs examples as 1K).
  if (lower === '0.5k' || lower === '512') return '512'
  if (lower === '1k') return '1K'
  if (lower === '2k') return '2K'
  if (lower === '4k') return '4K'
  if (r === '1K' || r === '2K' || r === '4K' || r === '512') return r
  return r
}

function toDataUri(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType || 'image/png'};base64,${bytes.toString('base64')}`
}

function mimeFromMediaType(
  mediaType: string | undefined,
  outputFormat: ImageOutputFormat | undefined
): string {
  if (mediaType?.trim()) {
    const m = mediaType.trim().toLowerCase().split(';')[0]!
    if (m === 'image/svg+xml' || m === 'image/jpeg' || m === 'image/jpg' || m === 'image/webp') {
      return m === 'image/jpg' ? 'image/jpeg' : m
    }
    if (m === 'image/png') return 'image/png'
    return mediaType.trim()
  }
  return mimeForOutputFormat(outputFormat)
}

export function mapOpenRouterImageError(status: number, body: string): ImageGenResult {
  const message = formatProviderHttpError(status, body, 'openrouter')
  let code: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: { code?: number | string; message?: string } }
    if (parsed.error?.code != null) code = String(parsed.error.code)
  } catch {
    /* ignore */
  }
  if (status === 402) {
    return {
      ok: false,
      error:
        'OpenRouter credits are insufficient for this image request. Add credits at https://openrouter.ai/settings/credits.',
      code: 'insufficient_credits'
    }
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      error:
        'OpenRouter authentication failed. Update your API key in Settings → Providers.',
      code: code ?? 'invalid_api_key'
    }
  }
  return { ok: false, error: message || `OpenRouter Images HTTP ${status}`, code }
}

export function parseOpenRouterImageResponse(
  text: string,
  opts?: { outputFormat?: ImageOutputFormat }
): ImageGenResult {
  let parsed: {
    data?: Array<{ b64_json?: string; media_type?: string }>
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { ok: false, error: 'OpenRouter Images returned invalid JSON' }
  }

  const entries = parsed.data ?? []
  const decoded: Array<{ bytes: Buffer; mimeType: string }> = []
  for (const entry of entries) {
    const b64 = entry?.b64_json
    if (!b64) continue
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.length === 0) continue
    decoded.push({
      bytes,
      mimeType: mimeFromMediaType(entry.media_type, opts?.outputFormat)
    })
  }

  if (decoded.length === 0) {
    return { ok: false, error: 'OpenRouter Images response did not include image data' }
  }

  const first = decoded[0]!
  return {
    ok: true,
    bytes: first.bytes,
    mimeType: first.mimeType,
    additionalImages:
      decoded.length > 1
        ? decoded.slice(1).map((d) => ({ bytes: d.bytes, mimeType: d.mimeType }))
        : undefined,
    moderationPassed: true
  }
}

function buildBody(req: ImageGenRequest, inputReferences?: Array<{ image_url: { url: string } }>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    n: clampN(req.n)
  }
  const resolution = normalizeResolution(req.resolution)
  if (resolution) body.resolution = resolution
  if (req.aspectRatio) body.aspect_ratio = req.aspectRatio
  // Prefer resolution/aspect_ratio; only send size when no resolution (OR treats them interchangeable).
  if (req.size && !resolution) body.size = req.size
  if (req.quality) body.quality = req.quality
  if (req.outputFormat) body.output_format = req.outputFormat
  if (req.outputCompression != null && req.outputFormat && req.outputFormat !== 'png' && req.outputFormat !== 'svg') {
    body.output_compression = req.outputCompression
  }
  if (req.background) body.background = req.background
  if (inputReferences && inputReferences.length > 0) {
    body.input_references = inputReferences
  }
  return body
}

async function softValidateModel(
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<ImageGenResult | null> {
  const found = await lookupOpenRouterImageModel(apiKey, model, { signal })
  if (found === 'unavailable') return null
  if (found === null) {
    return {
      ok: false,
      error: `OpenRouter image model "${model}" was not found in discovery. Check Settings → Image model or browse https://openrouter.ai/models?output_modalities=image`,
      code: 'model_not_found'
    }
  }
  return null
}

async function postImages(
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ImageGenResult> {
  let res: Response
  try {
    res = await fetchWithRetry(
      OPENROUTER_IMAGES_URL,
      {
        method: 'POST',
        headers: openRouterImageRequestHeaders(apiKey),
        body: JSON.stringify(body),
        signal
      },
      { maxAttempts: 3 }
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `OpenRouter Images request failed: ${msg}` }
  }

  const text = await res.text()
  if (!res.ok) return mapOpenRouterImageError(res.status, text)
  return parseOpenRouterImageResponse(text, {
    outputFormat: body.output_format as ImageOutputFormat | undefined
  })
}

export const openrouterImageAdapter: ImageGenAdapter = {
  providerId: 'openrouter',

  async generate(apiKey, req: ImageGenRequest): Promise<ImageGenResult> {
    const invalid = await softValidateModel(apiKey, req.model, req.signal)
    if (invalid) return invalid
    return postImages(apiKey, buildBody(req), req.signal)
  },

  async edit(apiKey, req: ImageEditRequest): Promise<ImageGenResult> {
    if (req.mask) {
      return {
        ok: false,
        error:
          'OpenRouter image edit does not support mask_path. Omit the mask, or use provider openai with a mask PNG.'
      }
    }
    if (req.images.length === 0) {
      return { ok: false, error: 'OpenRouter image edit requires at least one reference image' }
    }

    const invalid = await softValidateModel(apiKey, req.model, req.signal)
    if (invalid) return invalid

    const inputReferences = req.images.map((img) => ({
      image_url: { url: toDataUri(img.mimeType, img.bytes) }
    }))
    return postImages(apiKey, buildBody(req, inputReferences), req.signal)
  }
}
