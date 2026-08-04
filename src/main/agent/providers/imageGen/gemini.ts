import { fetchWithRetry } from '../fetchWithRetry'
import { formatProviderHttpError } from '../httpErrors'
import { MAX_GEMINI_EDIT_IMAGES } from './workspaceImages'
import type {
  ImageEditRequest,
  ImageGenAdapter,
  ImageGenRequest,
  ImageGenResult
} from './types'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

function extensionForMime(mime: string): { mimeType: string } {
  const m = mime.toLowerCase().split(';')[0]?.trim() || 'image/png'
  return { mimeType: m.startsWith('image/') ? m : 'image/png' }
}

/** Normalize to Gemini imageSize tokens: 0.5K | 1K | 2K | 4K (uppercase K). */
export function normalizeGeminiImageSize(resolution: string | undefined): string | undefined {
  if (!resolution) return undefined
  const r = resolution.trim().replace(/\s+/g, '')
  const m = /^(0\.5|1|2|4)[kK]$/.exec(r)
  if (m) return `${m[1]}K`
  return resolution.trim()
}

function buildGenerationConfig(req: Pick<ImageGenRequest, 'aspectRatio' | 'resolution'>): Record<string, unknown> {
  const imageConfig: Record<string, unknown> = {}
  if (req.aspectRatio) imageConfig.aspectRatio = req.aspectRatio
  const imageSize = normalizeGeminiImageSize(req.resolution)
  if (imageSize) imageConfig.imageSize = imageSize

  const generationConfig: Record<string, unknown> = {
    responseModalities: ['TEXT', 'IMAGE']
  }
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig
  }
  return generationConfig
}

function parseGeminiImageResponse(text: string): ImageGenResult {
  let parsed: {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>
      }
      finishReason?: string
    }>
    promptFeedback?: { blockReason?: string }
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { ok: false, error: 'Gemini image response was not valid JSON' }
  }

  if (parsed.promptFeedback?.blockReason) {
    return {
      ok: false,
      error: `Gemini blocked this prompt (${parsed.promptFeedback.blockReason}). Revise the prompt.`,
      code: 'moderation_blocked'
    }
  }

  const parts = parsed.candidates?.[0]?.content?.parts ?? []
  let revisedPrompt: string | undefined
  for (const part of parts) {
    if (typeof part.text === 'string' && part.text.trim()) {
      revisedPrompt = part.text.trim()
    }
    const data = part.inlineData?.data
    if (typeof data === 'string' && data.length > 0) {
      const { mimeType } = extensionForMime(part.inlineData?.mimeType ?? 'image/png')
      const bytes = Buffer.from(data, 'base64')
      if (bytes.length === 0) {
        return { ok: false, error: 'Gemini returned empty image bytes' }
      }
      return {
        ok: true,
        bytes,
        mimeType,
        revisedPrompt,
        moderationPassed: true
      }
    }
  }

  const finish = parsed.candidates?.[0]?.finishReason
  return {
    ok: false,
    error: finish
      ? `Gemini returned no image (finishReason=${finish}). Try a clearer image prompt.`
      : 'Gemini returned no image data. Try a clearer image prompt.'
  }
}

async function geminiGenerateContent(
  apiKey: string,
  model: string,
  parts: Array<Record<string, unknown>>,
  req: Pick<ImageGenRequest, 'aspectRatio' | 'resolution' | 'signal'>
): Promise<ImageGenResult> {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: buildGenerationConfig(req)
  }

  let res: Response
  try {
    res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(body),
        signal: req.signal
      },
      { maxAttempts: 3 }
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Gemini image request failed: ${msg}` }
  }

  const text = await res.text()
  if (!res.ok) {
    return { ok: false, error: formatProviderHttpError(res.status, text, 'gemini') }
  }
  return parseGeminiImageResponse(text)
}

export const geminiImageAdapter: ImageGenAdapter = {
  providerId: 'gemini',
  async generate(apiKey, req: ImageGenRequest): Promise<ImageGenResult> {
    return geminiGenerateContent(apiKey, req.model, [{ text: req.prompt }], req)
  },

  async edit(apiKey, req: ImageEditRequest): Promise<ImageGenResult> {
    if (req.images.length === 0) {
      return { ok: false, error: 'Gemini image edit requires at least one source image' }
    }
    if (req.images.length > MAX_GEMINI_EDIT_IMAGES) {
      return {
        ok: false,
        error: `Gemini image edit accepts at most ${MAX_GEMINI_EDIT_IMAGES} reference images (got ${req.images.length})`
      }
    }
    if (req.mask) {
      return {
        ok: false,
        error:
          'Gemini edit does not support mask_path. Describe the region in the prompt, or use OpenAI for mask inpainting.'
      }
    }

    const parts: Array<Record<string, unknown>> = []
    for (const img of req.images) {
      parts.push({
        inlineData: {
          mimeType: img.mimeType,
          data: img.bytes.toString('base64')
        }
      })
    }
    parts.push({
      text:
        req.images.length === 1
          ? req.prompt
          : `${req.prompt}\n\n(Reference images are ordered Image 1…Image ${req.images.length}.)`
    })

    return geminiGenerateContent(apiKey, req.model, parts, req)
  }
}
