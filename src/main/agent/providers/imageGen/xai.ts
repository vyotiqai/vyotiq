import { fetchWithRetry } from '../fetchWithRetry'
import { formatProviderHttpError } from '../httpErrors'
import { MAX_XAI_EDIT_IMAGES } from './workspaceImages'
import type {
  ImageEditRequest,
  ImageGenAdapter,
  ImageGenRequest,
  ImageGenResult
} from './types'

const XAI_GENERATIONS_URL = 'https://api.x.ai/v1/images/generations'
const XAI_EDITS_URL = 'https://api.x.ai/v1/images/edits'

/**
 * xAI still images support `1k` | `2k` only.
 * Invalid `4K`/`4k` is clamped to `2k` (no still 4K in primary docs).
 */
export function normalizeXaiResolution(resolution: string | undefined): {
  value?: string
  clampedFrom?: string
} {
  if (!resolution) return {}
  const raw = resolution.trim()
  const r = raw.toLowerCase().replace(/\s+/g, '')
  if (r === '1k') return { value: '1k' }
  if (r === '2k') return { value: '2k' }
  if (r === '4k') return { value: '2k', clampedFrom: raw }
  // Accept accidental Gemini-style tokens
  if (r === '1' || r === '1024') return { value: '1k' }
  if (r === '2' || r === '2048') return { value: '2k' }
  return { value: r }
}

function clampN(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return 1
  return Math.min(4, Math.max(1, Math.floor(n)))
}

function parseXaiImageResponse(text: string): ImageGenResult {
  let parsed: {
    data?: Array<{
      b64_json?: string
      revised_prompt?: string
      respect_moderation?: boolean
    }>
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { ok: false, error: 'xAI Imagine returned invalid JSON' }
  }

  const entries = parsed.data ?? []
  if (entries.length === 0) {
    return { ok: false, error: 'xAI Imagine response had no image entries' }
  }

  const decoded: Array<{ bytes: Buffer; revisedPrompt?: string }> = []
  for (const entry of entries) {
    if (entry.respect_moderation === false) {
      return {
        ok: false,
        error: 'xAI flagged this image under moderation. Revise the prompt; do not save the asset.',
        code: 'moderation_blocked'
      }
    }
    const b64 = entry.b64_json
    if (!b64) continue
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.length === 0) continue
    decoded.push({
      bytes,
      revisedPrompt: typeof entry.revised_prompt === 'string' ? entry.revised_prompt : undefined
    })
  }

  if (decoded.length === 0) {
    return {
      ok: false,
      error: 'xAI Imagine response did not include b64_json (temporary URLs are not used)'
    }
  }

  const first = decoded[0]!
  return {
    ok: true,
    bytes: first.bytes,
    mimeType: 'image/png',
    additionalImages:
      decoded.length > 1
        ? decoded.slice(1).map((d) => ({ bytes: d.bytes, mimeType: 'image/png' }))
        : undefined,
    revisedPrompt: first.revisedPrompt,
    moderationPassed: true
  }
}

function toDataUri(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`
}

export const xaiImageAdapter: ImageGenAdapter = {
  providerId: 'xai',
  async generate(apiKey, req: ImageGenRequest): Promise<ImageGenResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      n: clampN(req.n),
      response_format: 'b64_json'
    }
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio
    const resolution = normalizeXaiResolution(req.resolution)
    if (resolution.value) body.resolution = resolution.value

    let res: Response
    try {
      res = await fetchWithRetry(
        XAI_GENERATIONS_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(body),
          signal: req.signal
        },
        { maxAttempts: 3 }
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `xAI Imagine request failed: ${msg}` }
    }

    const text = await res.text()
    if (!res.ok) {
      return { ok: false, error: formatProviderHttpError(res.status, text, 'xai') }
    }
    return parseXaiImageResponse(text)
  },

  async edit(apiKey, req: ImageEditRequest): Promise<ImageGenResult> {
    if (req.images.length === 0) {
      return { ok: false, error: 'xAI image edit requires at least one source image' }
    }
    if (req.images.length > MAX_XAI_EDIT_IMAGES) {
      return {
        ok: false,
        error: `xAI image edit accepts at most ${MAX_XAI_EDIT_IMAGES} source images (got ${req.images.length})`
      }
    }
    if (req.mask) {
      return {
        ok: false,
        error:
          'xAI edit does not support mask_path. Describe the region in the prompt, or use OpenAI for mask inpainting.'
      }
    }

    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      n: clampN(req.n),
      response_format: 'b64_json'
    }
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio
    const resolution = normalizeXaiResolution(req.resolution)
    if (resolution.value) body.resolution = resolution.value

    // Single image: `image: { url, type }`. Multi: `image` array (multi-image editing).
    if (req.images.length === 1) {
      const img = req.images[0]!
      body.image = {
        url: toDataUri(img.mimeType, img.bytes),
        type: 'image_url'
      }
    } else {
      body.image = req.images.map((img) => ({
        url: toDataUri(img.mimeType, img.bytes),
        type: 'image_url'
      }))
    }

    let res: Response
    try {
      res = await fetchWithRetry(
        XAI_EDITS_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(body),
          signal: req.signal
        },
        { maxAttempts: 3 }
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `xAI Imagine edit request failed: ${msg}` }
    }

    const text = await res.text()
    if (!res.ok) {
      return { ok: false, error: formatProviderHttpError(res.status, text, 'xai') }
    }
    return parseXaiImageResponse(text)
  }
}
