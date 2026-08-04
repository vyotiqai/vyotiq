/** OpenAI GPT Image size constraints (gpt-image-2 and compatible). */

const OPENAI_ALLOWED_LITERAL = new Set([
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '1152x2048',
  '3840x2160',
  '2160x3840'
])

/** Pixels above this are valid but marked experimental by OpenAI guidance. */
const EXPERIMENTAL_PIXEL_THRESHOLD = 2560 * 1440

export type OpenAiSizeValidation =
  | { ok: true; size: string; experimental?: boolean }
  | { ok: false; error: string }

export type ValidateOpenAiSizeOpts = {
  /** Unused today; reserved for model-specific size ladders. */
  model?: string
}

export function parseOpenAiSizeWxH(
  raw: string
): { width: number; height: number } | null {
  const m = /^(\d+)x(\d+)$/i.exec(raw.trim())
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return null
  }
  return { width, height }
}

/**
 * Validate OpenAI Images `size` before HTTP to avoid avoidable 400s.
 * Accepts `auto`, popular literals, or WxH meeting edge/ratio/pixel rules.
 */
export function validateOpenAiImageSize(
  raw: string | undefined,
  _opts?: ValidateOpenAiSizeOpts
): OpenAiSizeValidation {
  if (!raw || !raw.trim()) return { ok: true, size: 'auto' }
  const size = raw.trim().toLowerCase()
  if (size === 'auto') return { ok: true, size: 'auto' }
  if (OPENAI_ALLOWED_LITERAL.has(size)) {
    const dims = parseOpenAiSizeWxH(size)
    if (!dims) return { ok: true, size }
    const pixels = dims.width * dims.height
    return {
      ok: true,
      size,
      experimental: pixels > EXPERIMENTAL_PIXEL_THRESHOLD
    }
  }

  const dims = parseOpenAiSizeWxH(size)
  if (!dims) {
    return {
      ok: false,
      error: `Invalid OpenAI image size "${raw}". Use auto or WxH (e.g. 1024x1024, 1536x1024).`
    }
  }
  const { width: w, height: h } = dims
  if (w > 3840 || h > 3840) {
    return {
      ok: false,
      error: `OpenAI image size max edge is 3840 (got ${w}x${h}).`
    }
  }
  if (w % 16 !== 0 || h % 16 !== 0) {
    return {
      ok: false,
      error: `OpenAI image size edges must be multiples of 16 (got ${w}x${h}).`
    }
  }
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  if (long / short > 3) {
    return {
      ok: false,
      error: `OpenAI image aspect ratio must be ≤ 3:1 (got ${w}x${h}).`
    }
  }
  const pixels = w * h
  if (pixels < 655_360 || pixels > 8_294_400) {
    return {
      ok: false,
      error: `OpenAI image pixel count must be between 655360 and 8294400 (got ${pixels} for ${w}x${h}).`
    }
  }
  return {
    ok: true,
    size: `${w}x${h}`,
    experimental: pixels > EXPERIMENTAL_PIXEL_THRESHOLD
  }
}
