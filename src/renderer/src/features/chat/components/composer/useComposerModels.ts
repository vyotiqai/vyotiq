import { useEffect, useMemo, useRef } from 'react'
import { PROVIDER_DEFAULTS, seedModelsFor, providerLabel } from '@shared/providers'
import type { ProviderId } from '@shared/ipc'
import { modelSelectionKey } from '@shared/domain/modelSelection'
import {
  filterModelsForWorkspace,
  modelsToOptions,
  seedOptionsForProvider,
  buildModelMetaMap,
  type ModelFilterOpts,
  type ModelPickerOption
} from './composerModelUtils'
import { useProviderCatalogCache } from './useProviderCatalogCache'

export function useComposerModels({
  provider,
  model,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  modelsRefreshKey,
  hasWorkspace,
  hasImages,
  hasAudio = false,
  browsedProvider
}: {
  provider: ProviderId
  model: string
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  modelsRefreshKey?: string | number
  hasWorkspace?: boolean
  hasImages: boolean
  hasAudio?: boolean
  browsedProvider?: ProviderId
}) {
  const value = modelSelectionKey(provider, model)
  const activeBrowse = browsedProvider ?? provider
  /** Browsed (non-active) providers: fetch once per tab open / refresh, not on every idle tick. */
  const browsedFetchedRef = useRef(new Set<ProviderId>())

  const { cache, loadProvider, getEntry } = useProviderCatalogCache(
    { ollamaBaseUrl, customOpenAiBaseUrl },
    modelsRefreshKey
  )

  const filterOpts: ModelFilterOpts = useMemo(
    () => ({ hasWorkspace: Boolean(hasWorkspace), hasImages, hasAudio }),
    [hasWorkspace, hasImages, hasAudio]
  )

  useEffect(() => {
    browsedFetchedRef.current.clear()
  }, [modelsRefreshKey])

  useEffect(() => {
    let cancelled = false
    let idleId: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const start = (): void => {
      if (!cancelled) void loadProvider(provider)
    }

    // Defer catalog network behind first paint — cold models:list was ~1.5s in the startup stampede.
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(start, { timeout: 1500 })
    } else {
      timer = setTimeout(start, 0)
    }

    return () => {
      cancelled = true
      if (idleId != null && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId)
      }
      if (timer != null) clearTimeout(timer)
    }
  }, [provider, modelsRefreshKey, loadProvider])

  useEffect(() => {
    if (activeBrowse === provider) return
    if (browsedFetchedRef.current.has(activeBrowse)) return
    browsedFetchedRef.current.add(activeBrowse)
    void loadProvider(activeBrowse)
  }, [activeBrowse, provider, loadProvider])

  const activeEntry = getEntry(provider)
  const liveModels = activeEntry?.models ?? null
  const modelsWarning = activeEntry?.warning ?? null

  const catalog =
    liveModels && liveModels.length > 0 ? liveModels : seedModelsFor(provider)
  const filtered = filterModelsForWorkspace(catalog, filterOpts)

  const optionsByProvider = useMemo(() => {
    const map = {} as Record<ProviderId, ModelPickerOption[]>
    for (const p of PROVIDER_DEFAULTS) {
      const label = p.label
      const entry = getEntry(p.id)
      const live = entry?.models
      if (live?.length) {
        const source = filterModelsForWorkspace(live, filterOpts)
        map[p.id] = modelsToOptions(p.id, source.length ? source : live, label)
      } else {
        const seeds = seedModelsFor(p.id)
        const seedFiltered = filterModelsForWorkspace(seeds, filterOpts)
        map[p.id] = modelsToOptions(
          p.id,
          seedFiltered.length ? seedFiltered : seeds,
          label
        )
      }
    }
    return map
  }, [cache, filterOpts, getEntry])

  const modelMetaByValue = useMemo(
    () => buildModelMetaMap(optionsByProvider),
    [optionsByProvider]
  )

  const seedsByProvider = useMemo(() => {
    const map = {} as Record<ProviderId, ModelPickerOption[]>
    for (const p of PROVIDER_DEFAULTS) {
      map[p.id] = seedOptionsForProvider(p.id)
    }
    return map
  }, [])

  const currentMeta = modelMetaByValue[value]

  const refreshCatalog = async (opts?: {
    forceRefresh?: boolean
    provider?: ProviderId
  }) => {
    const target = opts?.provider ?? activeBrowse
    const entry = await loadProvider(target, { forceRefresh: opts?.forceRefresh })
    return entry.models
      ? { ok: true as const, models: entry.models, warning: entry.warning }
      : { ok: false as const, error: entry.warning ?? 'Failed to load models' }
  }

  return {
    providers: PROVIDER_DEFAULTS.map((p) => p.id),
    optionsByProvider,
    seedsByProvider,
    modelMetaByValue,
    value,
    provider,
    model,
    providerLabel: providerLabel(provider),
    modelsWarning,
    catalogLoading: Boolean(getEntry(activeBrowse)?.loading),
    catalog,
    filtered,
    filterOpts,
    currentMeta,
    refreshCatalog,
    loadProvider
  }
}
