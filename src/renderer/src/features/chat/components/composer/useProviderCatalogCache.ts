import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeCustomOpenAiBaseUrl, ollamaNativeHost } from '@shared/providers'
import type { ModelInfo, ProviderId } from '@shared/ipc'

type CacheEntry = {
  models: ModelInfo[] | null
  warning: string | null
  loading: boolean
  /** Set when listModels failed so transient errors can expire. */
  failedAt?: number
}

const UNAVAILABLE: CacheEntry = {
  models: null,
  warning: 'Models API unavailable',
  loading: false
}

/** Allow another fetch after a failed catalog load without spinning forever. */
const ERROR_RETRY_MS = 30_000

function isRetryableFailure(entry: CacheEntry): boolean {
  if (entry.loading || entry.models) return false
  if (!entry.warning || entry.failedAt == null) return false
  return Date.now() - entry.failedAt >= ERROR_RETRY_MS
}

export function useProviderCatalogCache(
  baseUrls?: { ollamaBaseUrl?: string; customOpenAiBaseUrl?: string } | string,
  modelsRefreshKey?: string | number
) {
  // Back-compat: older callers passed ollamaBaseUrl as a bare string.
  const urls =
    typeof baseUrls === 'string' ? { ollamaBaseUrl: baseUrls } : (baseUrls ?? {})

  const [cache, setCache] = useState<Partial<Record<ProviderId, CacheEntry>>>({})
  const cacheRef = useRef(cache)
  const inflight = useRef(new Map<ProviderId, Promise<CacheEntry>>())

  const write = useCallback((provider: ProviderId, entry: CacheEntry) => {
    cacheRef.current = { ...cacheRef.current, [provider]: entry }
    setCache(cacheRef.current)
  }, [])

  const loadProvider = useCallback(
    async (provider: ProviderId, opts?: { forceRefresh?: boolean }): Promise<CacheEntry> => {
      // Settled successes stick. Failures stick briefly, then expire so a later
      // provider browse / remount can recover without force-refresh loops.
      const existing = cacheRef.current[provider]
      if (!opts?.forceRefresh && existing && !existing.loading && !isRetryableFailure(existing)) {
        return existing
      }

      const pending = inflight.current.get(provider)
      if (pending && !opts?.forceRefresh) return pending

      const run = (async () => {
        write(provider, {
          models: existing?.models ?? null,
          warning: existing?.warning ?? null,
          loading: true
        })

        if (!window.vyotiq?.listModels) {
          write(provider, UNAVAILABLE)
          return UNAVAILABLE
        }

        const baseUrl =
          provider === 'ollama' && urls.ollamaBaseUrl
            ? ollamaNativeHost(urls.ollamaBaseUrl)
            : provider === 'custom' && urls.customOpenAiBaseUrl
              ? normalizeCustomOpenAiBaseUrl(urls.customOpenAiBaseUrl)
              : undefined

        const res = await window.vyotiq.listModels({
          provider,
          baseUrl,
          forceRefresh: opts?.forceRefresh
        })

        const entry: CacheEntry = res.ok
          ? { models: res.data.models, warning: res.data.warning ?? null, loading: false }
          : {
              models: null,
              warning: res.error,
              loading: false,
              failedAt: Date.now()
            }
        write(provider, entry)
        return entry
      })()

      inflight.current.set(provider, run)
      try {
        return await run
      } finally {
        if (inflight.current.get(provider) === run) inflight.current.delete(provider)
      }
    },
    [urls.ollamaBaseUrl, urls.customOpenAiBaseUrl, write]
  )

  const refreshKeyRef = useRef(modelsRefreshKey)
  useEffect(() => {
    if (refreshKeyRef.current === modelsRefreshKey) return
    refreshKeyRef.current = modelsRefreshKey
    inflight.current.clear()
    cacheRef.current = {}
    setCache(cacheRef.current)
  }, [modelsRefreshKey])

  const getEntry = useCallback(
    (provider: ProviderId): CacheEntry | undefined => cache[provider],
    [cache]
  )

  return { cache, loadProvider, getEntry, modelsRefreshKey }
}
