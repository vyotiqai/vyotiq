/** Providers that expose an image generation API wired in VYOTIQ. */
export type ImageGenProviderId = 'openai' | 'gemini' | 'xai' | 'openrouter' | 'custom'

export const IMAGE_GEN_PROVIDERS: readonly ImageGenProviderId[] = [
  'openai',
  'gemini',
  'xai',
  'openrouter',
  'custom'
] as const

export const DEFAULT_IMAGE_MODELS: Record<ImageGenProviderId, string> = {
  openai: 'gpt-image-2',
  gemini: 'gemini-3.1-flash-image',
  xai: 'grok-imagine-image-quality',
  /** Documented OpenRouter Image API example slug; override via Settings → Image model. */
  openrouter: 'bytedance-seed/seedream-4.5',
  /**
   * Host-specific — override in Settings → Image model.
   * `dall-e-3` is a common OpenAI-compat alias; many local gateways use different ids.
   */
  custom: 'dall-e-3'
}

export type ImageOutputFormat = 'png' | 'jpeg' | 'webp' | 'svg'
export type ImageBackground = 'opaque' | 'transparent' | 'auto'

export type ImageGenRequest = {
  prompt: string
  model: string
  /** OpenAI-style WxH; ignored by providers that use aspect_ratio. */
  size?: string
  quality?: 'low' | 'medium' | 'high' | 'auto'
  aspectRatio?: string
  /** Gemini / xAI resolution hint (`0.5K`/`1K`/`2K`/`4K` / `1k`/`2k`). */
  resolution?: string
  /** Number of images (OpenAI/xAI; Gemini ignores). Practical UX max is 4. */
  n?: number
  /** OpenAI / OpenRouter output format (png/jpeg/webp; svg on OpenRouter vector models). */
  outputFormat?: ImageOutputFormat
  /** OpenAI jpeg/webp compression 0–100. */
  outputCompression?: number
  /** OpenAI / OpenRouter background; transparent is rejected for gpt-image-2. */
  background?: ImageBackground
  /** OpenAI-compatible `/v1` root (custom provider). */
  openAiBaseUrl?: string
  /** Loosen gpt-image-2 client checks for custom clones. */
  openAiCompatMode?: boolean
  signal?: AbortSignal
}

export type ImageEditInputImage = {
  bytes: Buffer
  mimeType: string
  filename: string
}

export type ImageEditRequest = ImageGenRequest & {
  /** Source / reference images (first = primary canvas when masks apply). */
  images: ImageEditInputImage[]
  /** Optional OpenAI-style mask (PNG with alpha); applied to the first image. */
  mask?: ImageEditInputImage
}

export type ImageGenSuccess = {
  ok: true
  bytes: Buffer
  mimeType: string
  /** Extra images when n>1 (does not include the primary `bytes`). */
  additionalImages?: Array<{ bytes: Buffer; mimeType: string }>
  revisedPrompt?: string
  width?: number
  height?: number
  moderationPassed?: boolean
  /** Set when size is valid but above OpenAI’s experimental pixel threshold. */
  experimentalSize?: boolean
}

export type ImageGenFailure = {
  ok: false
  error: string
  /** Provider error code when known (e.g. moderation_blocked). */
  code?: string
}

export type ImageGenResult = ImageGenSuccess | ImageGenFailure

export type ImageGenAdapter = {
  providerId: ImageGenProviderId
  generate(apiKey: string, req: ImageGenRequest): Promise<ImageGenResult>
  edit(apiKey: string, req: ImageEditRequest): Promise<ImageGenResult>
}
