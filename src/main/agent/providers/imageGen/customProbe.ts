/**
 * Capability probe for OpenAI-compatible custom hosts (`…/v1/images/generations`).
 * Chat Completions support does NOT imply image support — require Settings toggle + probe.
 */

import { fetchWithRetry } from '../fetchWithRetry'
import { normalizeCustomOpenAiBaseUrl } from '../../../../shared/domain/providers'

export type CustomImageProbeStatus = 'supported' | 'unsupported' | 'unknown'

type CacheEntry = {
  status: CustomImageProbeStatus
  checkedAt: number
  detail?: string
}

const cache = new Map<string, CacheEntry>()
const DEFAULT_TTL_MS = 30 * 60 * 1000

function cacheKey(baseUrl: string): string {
  return normalizeCustomOpenAiBaseUrl(baseUrl).toLowerCase()
}

export function generationsUrl(baseUrl: string): string {
  const root = normalizeCustomOpenAiBaseUrl(baseUrl).replace(/\/+$/, '')
  return `${root}/images/generations`
}

export function editsUrl(baseUrl: string): string {
  const root = normalizeCustomOpenAiBaseUrl(baseUrl).replace(/\/+$/, '')
  return `${root}/images/edits`
}

/**
 * Classify an HTTP status from a probe or real generate call.
 * 404/501 = host has no Images API. 400/401/402/403/422 = route exists.
 */
export function classifyCustomImageHttpStatus(status: number): CustomImageProbeStatus {
  if (status === 404 || status === 501) return 'unsupported'
  if (status >= 200 && status < 600) return 'supported'
  return 'unknown'
}

export function getCachedCustomImageProbe(baseUrl: string): CacheEntry | null {
  const key = cacheKey(baseUrl)
  const entry = cache.get(key)
  return entry ?? null
}

export function setCachedCustomImageProbe(
  baseUrl: string,
  status: CustomImageProbeStatus,
  detail?: string
): void {
  cache.set(cacheKey(baseUrl), {
    status,
    checkedAt: Date.now(),
    detail
  })
}

export function rememberCustomImageHttpResult(baseUrl: string, status: number): void {
  const classified = classifyCustomImageHttpStatus(status)
  if (classified === 'unknown') return
  setCachedCustomImageProbe(
    baseUrl,
    classified,
    classified === 'unsupported'
      ? `Host returned HTTP ${status} for /images/generations (no OpenAI Images API).`
      : undefined
  )
}

/**
 * Lightweight probe: POST an empty JSON body to `/images/generations`.
 * 404/501 → unsupported. 400/401/403/422 (or any other HTTP) → route exists.
 * Avoids a real image generation so working hosts are not billed for the probe.
 */
export async function probeCustomImageGenerations(
  apiKey: string,
  baseUrl: string,
  opts?: { force?: boolean; ttlMs?: number; signal?: AbortSignal; model?: string }
): Promise<CacheEntry> {
  const key = cacheKey(baseUrl)
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS
  const existing = cache.get(key)
  if (
    !opts?.force &&
    existing &&
    existing.status !== 'unknown' &&
    Date.now() - existing.checkedAt < ttl
  ) {
    return existing
  }

  const url = generationsUrl(baseUrl)
  let status: number
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers,
        // Intentionally invalid — proves the route without generating an image.
        body: '{}',
        signal: opts?.signal
      },
      { maxAttempts: 1 }
    )
    status = res.status
    await res.text().catch(() => '')
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    const detail = err instanceof Error ? err.message : String(err)
    const entry: CacheEntry = {
      status: 'unknown',
      checkedAt: Date.now(),
      detail: `Probe failed: ${detail}`
    }
    cache.set(key, entry)
    return entry
  }

  const classified = classifyCustomImageHttpStatus(status)
  const entry: CacheEntry = {
    status: classified,
    checkedAt: Date.now(),
    detail:
      classified === 'unsupported'
        ? `Custom host has no Images API (HTTP ${status} at ${url}). Enable only if the host implements POST /v1/images/generations.`
        : classified === 'supported'
          ? undefined
          : `Unexpected probe status HTTP ${status}`
  }
  cache.set(key, entry)
  return entry
}

/**
 * Ensure custom images are allowed before calling the adapter.
 * Uses cache; probes when unknown / stale.
 */
export async function ensureCustomImageSupported(
  apiKey: string,
  baseUrl: string,
  opts?: { signal?: AbortSignal; model?: string; skipProbe?: boolean }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cached = getCachedCustomImageProbe(baseUrl)
  if (cached?.status === 'unsupported') {
    return {
      ok: false,
      error:
        cached.detail ??
        'Custom host does not support OpenAI Images (`/v1/images/generations`). Turn off “Enable image generation on custom host” or use OpenAI/Gemini/xAI/OpenRouter.'
    }
  }
  if (cached?.status === 'supported') return { ok: true }
  if (opts?.skipProbe) return { ok: true }

  const probed = await probeCustomImageGenerations(apiKey, baseUrl, {
    signal: opts?.signal,
    model: opts?.model
  })
  if (probed.status === 'unsupported') {
    return {
      ok: false,
      error:
        probed.detail ??
        'Custom host does not support OpenAI Images (`/v1/images/generations`).'
    }
  }
  // unknown → allow the real generate attempt (network blip / auth-only failure).
  return { ok: true }
}

export function clearCustomImageProbeCache(): void {
  cache.clear()
}
