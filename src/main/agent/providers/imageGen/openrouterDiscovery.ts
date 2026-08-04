/**
 * OpenRouter Image API model discovery cache.
 * @see https://openrouter.ai/docs/api/api-reference/images/list-image-generation-models
 */

import { fetchWithRetry } from '../fetchWithRetry'

const MODELS_URL = 'https://openrouter.ai/api/v1/images/models'
const DEFAULT_TTL_MS = 60 * 60 * 1000

export type OpenRouterImageModel = {
  id: string
  name?: string
  supportsStreaming?: boolean
  /** Parameter names advertised on the model (union across endpoints). */
  supportedParameters?: string[]
}

type CacheEntry = {
  fetchedAt: number
  models: OpenRouterImageModel[]
  byId: Map<string, OpenRouterImageModel>
}

let cache: CacheEntry | null = null
let inflight: Promise<CacheEntry> | null = null

function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://vyotiq.com',
    'X-Title': 'Vyotiq'
  }
}

function parseModelsPayload(text: string): OpenRouterImageModel[] {
  let parsed: {
    data?: Array<{
      id?: string
      name?: string
      supports_streaming?: boolean
      supported_parameters?: Record<string, unknown> | string[]
    }>
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return []
  }

  const out: OpenRouterImageModel[] = []
  for (const row of parsed.data ?? []) {
    if (typeof row?.id !== 'string' || !row.id.trim()) continue
    let supportedParameters: string[] | undefined
    if (Array.isArray(row.supported_parameters)) {
      supportedParameters = row.supported_parameters.filter((p): p is string => typeof p === 'string')
    } else if (row.supported_parameters && typeof row.supported_parameters === 'object') {
      supportedParameters = Object.keys(row.supported_parameters)
    }
    out.push({
      id: row.id.trim(),
      name: typeof row.name === 'string' ? row.name : undefined,
      supportsStreaming: Boolean(row.supports_streaming),
      supportedParameters
    })
  }
  return out
}

async function fetchModels(apiKey: string, signal?: AbortSignal): Promise<CacheEntry> {
  const res = await fetchWithRetry(
    MODELS_URL,
    {
      method: 'GET',
      headers: openRouterHeaders(apiKey),
      signal
    },
    { maxAttempts: 2 }
  )
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`OpenRouter image models list failed (HTTP ${res.status})`)
  }
  const models = parseModelsPayload(text)
  const byId = new Map(models.map((m) => [m.id.toLowerCase(), m]))
  return { fetchedAt: Date.now(), models, byId }
}

/**
 * List OpenRouter image models (cached). Failures leave the previous cache if any.
 */
export async function listOpenRouterImageModels(
  apiKey: string,
  opts?: { force?: boolean; ttlMs?: number; signal?: AbortSignal }
): Promise<OpenRouterImageModel[]> {
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS
  if (!opts?.force && cache && Date.now() - cache.fetchedAt < ttl) {
    return cache.models
  }

  if (!opts?.force && inflight) {
    const entry = await inflight
    return entry.models
  }

  const pending = fetchModels(apiKey, opts?.signal)
    .then((entry) => {
      cache = entry
      return entry
    })
    .finally(() => {
      inflight = null
    })
  inflight = pending
  try {
    const entry = await pending
    return entry.models
  } catch (err) {
    if (cache) return cache.models
    throw err
  }
}

/**
 * Soft model check against discovery. Returns null when discovery is unavailable
 * (caller may still attempt generate).
 */
export async function lookupOpenRouterImageModel(
  apiKey: string,
  modelId: string,
  opts?: { signal?: AbortSignal }
): Promise<OpenRouterImageModel | null | 'unavailable'> {
  const id = modelId.trim()
  if (!id) return null
  try {
    await listOpenRouterImageModels(apiKey, { signal: opts?.signal })
  } catch {
    return 'unavailable'
  }
  if (!cache) return 'unavailable'
  return cache.byId.get(id.toLowerCase()) ?? null
}

/** Test helper — clear discovery cache. */
export function clearOpenRouterImageDiscoveryCache(): void {
  cache = null
  inflight = null
}

export function openRouterImageRequestHeaders(apiKey: string): Record<string, string> {
  return {
    ...openRouterHeaders(apiKey),
    'Content-Type': 'application/json'
  }
}
