import type { ProviderId, Settings } from '../../../shared/ipc'
import {
  isOllamaCloudHost,
  providerNeedsKey
} from '../../../shared/domain/providers'
import { hasImageGenKey, isImageGenProviderId, type ImageGenProviderId } from './imageGen'

export type ProviderPreflightFailure = {
  code: 'PROVIDER_AUTH' | 'PROVIDER_KEYCHAIN' | 'PROVIDER_KEY_DECRYPT'
  message: string
}

/**
 * Fail-closed checks before starting an agent stream (keys / host mismatches).
 * Does not hit the network — invalid-but-present keys still fail at request time.
 */
export function preflightChatProviderAuth(opts: {
  providerId: ProviderId
  apiKey: string | null
  baseUrl: string | null | undefined
  encryptionAvailable: boolean
  hasStoredBlob: boolean
}): ProviderPreflightFailure | null {
  const { providerId, apiKey, baseUrl, encryptionAvailable, hasStoredBlob } = opts
  if (!providerNeedsKey(providerId, baseUrl ?? undefined)) return null
  if (apiKey?.trim()) return null

  if (!encryptionAvailable) {
    return {
      code: 'PROVIDER_KEYCHAIN',
      message:
        'OS secure storage is unavailable. API keys cannot be decrypted on this system.'
    }
  }
  if (hasStoredBlob) {
    return {
      code: 'PROVIDER_KEY_DECRYPT',
      message: `API key for ${providerId} is stored but cannot be decrypted. Re-enter it in Settings or restore OS keychain access.`
    }
  }
  if (providerId === 'ollama' && isOllamaCloudHost(baseUrl ?? '')) {
    return {
      code: 'PROVIDER_AUTH',
      message:
        'Ollama Cloud (ollama.com) requires an API key. Add it in Settings → Providers, or switch the Ollama base URL to a local host (e.g. http://127.0.0.1:11434).'
    }
  }
  return {
    code: 'PROVIDER_AUTH',
    message: `API key for ${providerId} is not set. Add it in Settings → Providers.`
  }
}

/** Soft warning when a fixed image provider is selected without a usable key. */
export function preflightImageProviderWarning(settings: Settings): string | null {
  const raw = settings.imageProvider?.trim() || 'auto'
  if (!raw || raw === 'auto') return null
  if (!isImageGenProviderId(raw)) {
    return `imageProvider "${raw}" is not a known image provider. Set it to auto or a supported id in Settings.`
  }
  if (
    hasImageGenKey(raw as ImageGenProviderId, {
      customOpenAiBaseUrl: settings.customOpenAiBaseUrl
    })
  ) {
    return null
  }
  return `Image provider is set to "${raw}" but no API key is available. generate_image will fail until you add a key in Settings → Providers.`
}
