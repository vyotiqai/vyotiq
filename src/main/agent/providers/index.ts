import type { ModelInfo, ProviderId } from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import { withResolvedContextWindow } from '../../../shared/domain/modelContextWindows'
import { providerLabel, providerNeedsKey, seedModelsFor } from '../../../shared/providers'
import { anthropicProvider } from './anthropic'
import { geminiProvider } from './gemini'
import {
  beginModelListFetch,
  clearModelCacheKey,
  clearModelListInflight,
  getCachedModels,
  getModelListInflight,
  modelCacheKey,
  setCachedModels,
  setModelListInflight
} from './modelCache'
import {
  assertValidProviderBaseUrl,
  customProvider,
  deepseekProvider,
  groqProvider,
  mistralProvider,
  ollamaProvider,
  openaiProvider,
  openrouterProvider,
  xaiProvider
} from './openai'
import type { ListModelsRequest, LlmProvider } from './types'

const providers: Record<ProviderId, LlmProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
  deepseek: deepseekProvider,
  groq: groqProvider,
  openrouter: openrouterProvider,
  xai: xaiProvider,
  mistral: mistralProvider,
  custom: customProvider
}

export function getProvider(id: ProviderId): LlmProvider {
  return providers[id]
}

/** Map catalog failures into provider-aware, actionable warnings. */
export function catalogWarningMessage(provider: ProviderId, err: unknown): string {
  const label = providerLabel(provider)
  const raw = formatError(err)

  if (/API key not set/i.test(raw)) {
    return `${raw} Save a key in Providers settings, then refresh.`
  }

  if (/HTTP 401/i.test(raw)) {
    // DeepSeek (and some gateways) return this exact body when Authorization is missing/invalid.
    if (/Authentication Fails \(governor\)/i.test(raw)) {
      return `${label} returned HTTP 401 Authentication Fails (governor) — usually a missing or invalid API key. Save a valid ${label} key in Providers, then refresh.`
    }
    return `${label} returned HTTP 401 (unauthorized). Check the saved API key, then refresh.`
  }

  if (/HTTP 403/i.test(raw)) {
    return `${label} returned HTTP 403 (forbidden). Check the API key permissions.`
  }

  if (/Cannot reach Ollama|Cannot reach custom|returned no models/i.test(raw)) {
    return `${raw} Showing seed defaults (not live models).`
  }

  return `${label}: ${raw}. Showing seed defaults (not live models).`
}

function enrichCatalogModels(provider: ProviderId, models: ModelInfo[]): ModelInfo[] {
  return models.map((m) => withResolvedContextWindow(m, provider))
}

/** Combine a user abort signal with a timeout, even when AbortSignal.any is unavailable. */
function combinedListSignal(userSignal: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  if (!userSignal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([userSignal, timeout])
  if (userSignal.aborted || timeout.aborted) {
    const done = new AbortController()
    done.abort()
    return done.signal
  }
  const combined = new AbortController()
  const onAbort = (): void => {
    userSignal.removeEventListener('abort', onAbort)
    timeout.removeEventListener('abort', onAbort)
    if (!combined.signal.aborted) combined.abort()
  }
  userSignal.addEventListener('abort', onAbort, { once: true })
  timeout.addEventListener('abort', onAbort, { once: true })
  return combined.signal
}

export async function listProviderModels(input: {
  provider: ProviderId
  apiKey?: string | null
  baseUrl?: string
  signal?: AbortSignal
  forceRefresh?: boolean
}): Promise<{ models: ModelInfo[]; warning?: string }> {
  const key = modelCacheKey(input.provider, input.baseUrl, input.apiKey)
  if (!input.forceRefresh) {
    const cached = getCachedModels(key)
    if (cached) return { models: enrichCatalogModels(input.provider, cached) }
    const pending = getModelListInflight(key)
    if (pending) return pending
  } else {
    // Drop memory/inflight so Refresh cannot join a stale in-flight catalog fetch.
    clearModelCacheKey(key)
  }

  const generation = beginModelListFetch(key)
  const run = listProviderModelsUncached(input, key, generation)
  setModelListInflight(key, run)
  try {
    return await run
  } finally {
    clearModelListInflight(key, run)
  }
}

async function listProviderModelsUncached(
  input: {
    provider: ProviderId
    apiKey?: string | null
    baseUrl?: string
    signal?: AbortSignal
    forceRefresh?: boolean
  },
  key: string,
  generation: number
): Promise<{ models: ModelInfo[]; warning?: string }> {
  if (providerNeedsKey(input.provider, input.baseUrl) && !input.apiKey?.trim()) {
    const seeds = seedModelsFor(input.provider)
    return {
      models: enrichCatalogModels(input.provider, seeds),
      warning: catalogWarningMessage(
        input.provider,
        new Error(`${providerLabel(input.provider)} API key not set`)
      )
    }
  }

  const provider = getProvider(input.provider)
  const timeout = AbortSignal.timeout(10_000)
  const signal = combinedListSignal(input.signal, timeout)
  const req: ListModelsRequest = {
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    signal
  }

  try {
    if (input.baseUrl) {
      assertValidProviderBaseUrl(input.baseUrl)
    }
    const models = await provider.listModels(req)
    if (!models.length) {
      if (input.forceRefresh) clearModelCacheKey(key)
      const seeds = seedModelsFor(input.provider)
      return {
        models: enrichCatalogModels(input.provider, seeds),
        warning: `${providerLabel(input.provider)} live catalog was empty; showing seed defaults (not installed models).`
      }
    }
    const enriched = enrichCatalogModels(input.provider, models)
    setCachedModels(key, enriched, generation)
    return { models: enriched }
  } catch (err) {
    if (input.forceRefresh) clearModelCacheKey(key)
    const seeds = seedModelsFor(input.provider)
    const raw = formatError(err)
    const providerAlreadyExplained = /Cannot reach Ollama|Cannot reach custom|returned no models|HTTP \d+|API key not set/i.test(
      raw
    )
    const timedOut =
      !providerAlreadyExplained &&
      (raw === 'Request timed out' ||
        raw === 'Request aborted' ||
        (timeout.aborted && /abort|timed out/i.test(raw)))
    if (timedOut) {
      return {
        models: enrichCatalogModels(input.provider, seeds),
        warning: `Timed out after 10s reaching ${providerLabel(input.provider)}${
          input.baseUrl ? ` at ${normalizeHostForWarning(input.baseUrl)}` : ''
        }. Showing seed defaults (not live models).`
      }
    }
    return {
      models: enrichCatalogModels(input.provider, seeds),
      warning: catalogWarningMessage(input.provider, err)
    }
  }
}

function normalizeHostForWarning(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/i, '').replace(/\/$/, '')
}

export type { LlmProvider, StreamChunk, ToolCall, ProviderChatRequest, TokenUsage } from './types'
