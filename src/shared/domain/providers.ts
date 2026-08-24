import type { ModelInfo, ProviderId } from '../ipc/schemas/providers'
import type { SecretProvider } from '../ipc/types/secrets'
import { knownContextWindow } from './modelContextWindows'
import {
  modelSupportsThinking,
  thinkingApiFor,
  ollamaThinkingHeuristicFields
} from '../reasoning'

export type ProviderDefault = {
  id: ProviderId
  label: string
  models: string[]
}

const SEED_MODEL_IDS: Record<ProviderId, string[]> = {
  openai: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  anthropic: ['claude-opus-5', 'claude-sonnet-4', 'claude-haiku-4-5'],
  gemini: ['gemini-3.6-flash', 'gemini-2.5-pro'],
  ollama: ['qwen2.5', 'llama3.2', 'deepseek-r1', 'gpt-oss:120b', 'deepseek-v4-flash'],
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  groq: ['llama-4-scout-17b-16e-instruct'],
  openrouter: ['openrouter/auto'],
  xai: ['grok-4-latest'],
  mistral: ['mistral-large-latest'],
  custom: ['gpt-oss-120b', 'llama3.2', 'qwen2.5']
}

function seedModelInfo(id: string, providerId: ProviderId): ModelInfo {
  const supportsVision = /gpt-4o|gpt-5|claude|gemini|grok|llava|vision|pixtral/i.test(id)
  const supportsThinking = modelSupportsThinking(id, providerId)
  const known = knownContextWindow(id, providerId)
  const ollamaThinking =
    (providerId === 'ollama' || providerId === 'custom') && supportsThinking
      ? ollamaThinkingHeuristicFields(id)
      : undefined
  return {
    id,
    displayName: id,
    inputModalities: supportsVision ? ['text', 'image'] : ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsVision,
    supportsStructuredOutput:
      providerId === 'ollama' ? /json|qwen|llama|deepseek/i.test(id) : true,
    supportsThinking,
    thinkingApi: supportsThinking ? thinkingApiFor(id, providerId) : undefined,
    ...(ollamaThinking ?? {}),
    contextWindow: known ?? (providerId === 'ollama' ? 32_768 : 128_000),
    isPlaceholder: true
  }
}

export const PROVIDER_DEFAULTS: ProviderDefault[] = [
  { id: 'openai', label: 'OpenAI', models: SEED_MODEL_IDS.openai },
  { id: 'anthropic', label: 'Anthropic', models: SEED_MODEL_IDS.anthropic },
  { id: 'gemini', label: 'Gemini', models: SEED_MODEL_IDS.gemini },
  { id: 'ollama', label: 'Ollama', models: SEED_MODEL_IDS.ollama },
  { id: 'deepseek', label: 'DeepSeek', models: SEED_MODEL_IDS.deepseek },
  { id: 'groq', label: 'Groq', models: SEED_MODEL_IDS.groq },
  { id: 'openrouter', label: 'OpenRouter', models: SEED_MODEL_IDS.openrouter },
  { id: 'xai', label: 'xAI', models: SEED_MODEL_IDS.xai },
  { id: 'mistral', label: 'Mistral', models: SEED_MODEL_IDS.mistral },
  { id: 'custom', label: 'Custom OpenAI-compatible', models: SEED_MODEL_IDS.custom }
]

export function seedModelsFor(provider: ProviderId): ModelInfo[] {
  return SEED_MODEL_IDS[provider].map((id) => seedModelInfo(id, provider))
}

export function defaultModelFor(provider: ProviderId): string {
  return SEED_MODEL_IDS[provider][0]!
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_DEFAULTS.find((entry) => entry.id === provider)?.label ?? provider
}

export const OLLAMA_LOCAL_DEFAULT = 'http://127.0.0.1:11434'
export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com'
/** Default OpenAI-compatible gateway (local vLLM / llama.cpp / etc.). */
export const CUSTOM_OPENAI_DEFAULT = 'http://127.0.0.1:8080/v1'

/**
 * Loopback or private LAN host (RFC1918 + link-local + .local/.localhost).
 * Used so custom OpenAI-compat gateways on the LAN can stay keyless.
 */
export function isPrivateOrLoopbackHost(url: string): boolean {
  try {
    const hostname = new URL(
      normalizeCustomOpenAiBaseUrl(url || CUSTOM_OPENAI_DEFAULT)
    ).hostname.toLowerCase()
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      return true
    }
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
    if (!m) return false
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 10 || a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    return false
  } catch {
    return false
  }
}

/**
 * Whether a provider requires an API key for live catalog/chat.
 * Local Ollama and private/LAN custom OpenAI-compat hosts do not; cloud hosts do.
 */
export function providerNeedsKey(provider: ProviderId, baseUrl?: string): boolean {
  if (provider === 'ollama') return isOllamaCloudHost(baseUrl ?? '')
  if (provider === 'custom') {
    return !isPrivateOrLoopbackHost(normalizeCustomOpenAiBaseUrl(baseUrl ?? CUSTOM_OPENAI_DEFAULT))
  }
  return true
}

export function normalizeOllamaHost(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return OLLAMA_LOCAL_DEFAULT
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`
  return trimmed
}

/** Native Ollama host (no trailing `/v1`) — safe to append `/v1` or `/api/...`. */
export function ollamaNativeHost(url: string): string {
  return normalizeOllamaHost(url).replace(/\/v1$/i, '')
}

/** True when the host is Ollama's cloud API (`ollama.com`). */
export function isOllamaCloudHost(url: string): boolean {
  try {
    const hostname = new URL(ollamaNativeHost(url || OLLAMA_LOCAL_DEFAULT)).hostname.toLowerCase()
    return hostname === 'ollama.com' || hostname.endsWith('.ollama.com')
  } catch {
    return false
  }
}

/** Loopback / local daemon hosts (not a remote Ollama server). */
export function isLocalOllamaHost(url: string): boolean {
  try {
    const hostname = new URL(ollamaNativeHost(url || OLLAMA_LOCAL_DEFAULT)).hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]'
    )
  } catch {
    return false
  }
}

/**
 * Route to Ollama Cloud when an API key is set and the configured URL is still local.
 * Explicit remote hosts (including cloud) are left unchanged.
 */
export function resolveEffectiveOllamaHost(
  configuredUrl: string | undefined,
  apiKey?: string | null
): string {
  const configured = ollamaNativeHost(configuredUrl ?? OLLAMA_LOCAL_DEFAULT)
  if (apiKey?.trim() && isLocalOllamaHost(configured)) {
    return OLLAMA_CLOUD_BASE_URL
  }
  return configured
}

export function ollamaOpenAiBaseUrl(url: string): string {
  return `${ollamaNativeHost(url)}/v1`
}

export function resolveOllamaListBaseUrl(
  reqBase?: string,
  settingsBase?: string,
  apiKey?: string | null
): string {
  return resolveEffectiveOllamaHost(reqBase ?? settingsBase ?? OLLAMA_LOCAL_DEFAULT, apiKey)
}

/**
 * Normalize a custom OpenAI-compatible base URL.
 * Ensures http(s) scheme and an OpenAI-style `/v1` mount without doubling.
 *
 * Hosts may expose the mount at `/v1` or with a vendor suffix (e.g. DeepInfra
 * `…/v1/openai`). Older builds appended `/v1` whenever the URL did not *end*
 * with `/v1`, corrupting those bases to `…/v1/openai/v1` (HTTP 404 on
 * `/models` and chat). Repair that shape on load.
 */
export function normalizeCustomOpenAiBaseUrl(url: string): string {
  let trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return CUSTOM_OPENAI_DEFAULT
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `http://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return CUSTOM_OPENAI_DEFAULT
  }

  let path = parsed.pathname.replace(/\/+$/, '')
  // Collapse …/v1/<suffix>/v1 from the prior “must end with /v1” rule.
  while (/\/v1\//i.test(path) && /\/v1$/i.test(path)) {
    path = path.replace(/\/v1$/i, '')
  }
  if (!/(^|\/)v1(\/|$)/i.test(path)) {
    path = path ? `${path}/v1` : '/v1'
  }
  if (!path.startsWith('/')) path = `/${path}`

  parsed.pathname = path
  parsed.search = ''
  parsed.hash = ''
  // Prefer href so userinfo (rare basic-auth bases) is preserved; origin strips it.
  return parsed.href.replace(/\/+$/, '')
}

type ProviderBaseUrlSettings = {
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
}

/** Chat / listModels base URL when the provider uses a configurable host. */
export function resolveProviderChatBaseUrl(
  providerId: ProviderId,
  settings: ProviderBaseUrlSettings,
  apiKey?: string | null
): string | undefined {
  if (providerId === 'ollama') {
    return ollamaOpenAiBaseUrl(resolveEffectiveOllamaHost(settings.ollamaBaseUrl, apiKey))
  }
  if (providerId === 'custom') {
    return normalizeCustomOpenAiBaseUrl(settings.customOpenAiBaseUrl ?? CUSTOM_OPENAI_DEFAULT)
  }
  return undefined
}

/** Catalog listModels base URL (native host for Ollama; `/v1` base for custom). */
export function resolveProviderListBaseUrl(
  providerId: ProviderId,
  reqBase: string | undefined,
  settings: ProviderBaseUrlSettings,
  apiKey?: string | null
): string | undefined {
  if (providerId === 'ollama') {
    return resolveOllamaListBaseUrl(reqBase, settings.ollamaBaseUrl, apiKey)
  }
  if (providerId === 'custom') {
    return normalizeCustomOpenAiBaseUrl(
      reqBase ?? settings.customOpenAiBaseUrl ?? CUSTOM_OPENAI_DEFAULT
    )
  }
  return reqBase
}

export type ProviderConfiguredOpts = {
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
}

export type ListConfiguredProvidersOpts = ProviderConfiguredOpts & {
  alwaysInclude?: ProviderId[]
}

function resolveProviderBaseUrlForKey(
  provider: ProviderId,
  opts?: ProviderConfiguredOpts
): string | undefined {
  if (provider === 'ollama') return opts?.ollamaBaseUrl
  if (provider === 'custom') return opts?.customOpenAiBaseUrl
  return undefined
}

/** True when the provider has a saved key or does not require one for its current host. */
export function isProviderConfigured(
  provider: ProviderId,
  secrets: Record<SecretProvider, boolean>,
  opts?: ProviderConfiguredOpts
): boolean {
  if (secrets[provider as SecretProvider]) return true
  const baseUrl = resolveProviderBaseUrlForKey(provider, opts)
  return !providerNeedsKey(provider, baseUrl)
}

/** Provider ids that are configured, preserving catalog order. */
export function listConfiguredProviders(
  secrets: Record<SecretProvider, boolean>,
  opts?: ListConfiguredProvidersOpts
): ProviderId[] {
  const include = new Set(opts?.alwaysInclude ?? [])
  const configured = PROVIDER_DEFAULTS.filter(
    (entry) => isProviderConfigured(entry.id, secrets, opts) || include.has(entry.id)
  ).map((entry) => entry.id)
  for (const id of include) {
    if (!configured.includes(id)) configured.push(id)
  }
  return configured
}

/** Menu options for configured providers only. */
export function providerOptionsForConfigured(
  secrets: Record<SecretProvider, boolean>,
  opts?: ListConfiguredProvidersOpts
): { value: ProviderId; label: string }[] {
  return listConfiguredProviders(secrets, opts).map((id) => ({
    value: id,
    label: providerLabel(id)
  }))
}
