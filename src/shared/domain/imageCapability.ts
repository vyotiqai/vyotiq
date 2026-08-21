import type { ImageProviderSetting, SecretProvider } from '../ipc'
import { providerNeedsKey } from './providers'

const IMAGE_PROVIDERS = ['openai', 'gemini', 'xai', 'openrouter', 'custom'] as const
type ImageCapable = (typeof IMAGE_PROVIDERS)[number]

function isImageCapable(id: string): id is ImageCapable {
  return (IMAGE_PROVIDERS as readonly string[]).includes(id)
}

/**
 * Short composer/settings hint for whether generate_image can run.
 * Returns null when no image-capable key is present.
 * Custom requires `customImageEnabled` plus a saved Custom key, or a keyless
 * private/LAN base URL (same policy as chat `providerNeedsKey`).
 */
export function resolveImageReadyLabel(opts: {
  imageProvider: ImageProviderSetting | string | null | undefined
  secrets: Partial<Record<SecretProvider | string, boolean>>
  customImageEnabled?: boolean
  customOpenAiBaseUrl?: string
}): string | null {
  const customKeyless =
    Boolean(opts.customImageEnabled) &&
    Boolean(opts.customOpenAiBaseUrl?.trim()) &&
    !providerNeedsKey('custom', opts.customOpenAiBaseUrl)
  const customOk =
    Boolean(opts.customImageEnabled) && (Boolean(opts.secrets.custom) || customKeyless)
  const has = (id: ImageCapable): boolean => {
    if (id === 'custom') return customOk
    return Boolean(opts.secrets[id])
  }
  const raw = (opts.imageProvider ?? 'auto').trim().toLowerCase() || 'auto'

  if (raw !== 'auto' && isImageCapable(raw)) {
    return has(raw) ? `Image ready: ${labelFor(raw)}` : null
  }

  for (const id of IMAGE_PROVIDERS) {
    if (has(id)) return `Image ready: ${labelFor(id)}`
  }
  return null
}

function labelFor(id: ImageCapable): string {
  if (id === 'openai') return 'OpenAI'
  if (id === 'gemini') return 'Gemini'
  if (id === 'xai') return 'xAI'
  if (id === 'openrouter') return 'OpenRouter'
  return 'Custom'
}
