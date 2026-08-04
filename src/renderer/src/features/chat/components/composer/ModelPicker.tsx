import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@renderer/lib/icons'
import { SearchInput } from '@renderer/lib/ui/SearchInput'
import { Tooltip } from '@renderer/lib/ui/Tooltip'
import { cn } from '@renderer/lib/ui/cn'
import { prefersReducedMotion } from '@renderer/lib/utils/motion'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import type { ProviderId, ServiceTier } from '@shared/ipc'
import { PROVIDER_DEFAULTS } from '@shared/providers'
import { modelSelectionKey, parseModelSelectionKey } from '@shared/domain/modelSelection'
import {
  SERVICE_TIER_DESCRIPTIONS,
  SERVICE_TIER_LABELS
} from '@shared/domain/serviceTier'
import { ProviderLogo } from './ProviderLogo'
import {
  formatModelDisplayName,
  resolvePickerOption,
  supportedTiersForModel,
  type ModelPickerOption
} from './composerModelUtils'
import { clampComposerDropdownPanel } from './composerDropdownLayout'

const SESSION_TAB_KEY = 'vyotiq:model-picker-tab'

function readSessionTab(fallback: ProviderId, providers: ProviderId[]): ProviderId {
  try {
    const stored = sessionStorage.getItem(SESSION_TAB_KEY)
    if (stored && providers.includes(stored as ProviderId)) {
      return stored as ProviderId
    }
  } catch {
    // ignore
  }
  return fallback
}

const optionClass = cn(
  'relative flex w-full cursor-pointer items-center gap-2 rounded-lg bg-transparent py-1.5 pl-2.5 pr-12 text-left text-sm text-fg',
  'hover:bg-surface active:bg-surface-2',
  'vy-transition'
)

const badgeChip =
  'rounded px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted ring-1 ring-border'

const PANEL_MAX_PX = 512

/** Fixed Think / Vision / Tools columns; missing slots stay invisible so tags align. */
function CapabilityBadges({ meta }: { meta?: ModelPickerOption['meta'] }) {
  if (!meta) return null
  const hasThink = Boolean(meta.supportsThinking)
  const hasVision = Boolean(meta.supportsVision || meta.inputModalities.includes('image'))
  const hasTools = Boolean(meta.supportsTools)
  const hasAudio = meta.inputModalities.includes('audio')
  if (!hasThink && !hasVision && !hasTools && !hasAudio) return null

  const slots: { key: string; label: string; on: boolean }[] = [
    { key: 'Think', label: 'Think', on: hasThink },
    { key: 'Vision', label: 'Vision', on: hasVision },
    { key: 'Tools', label: 'Tools', on: hasTools }
  ]

  return (
    <span className="flex shrink-0 gap-0.5" data-capability-badges>
      {slots.map((s) => (
        <span key={s.key} className={cn(badgeChip, !s.on && 'invisible')} aria-hidden={!s.on}>
          {s.label}
        </span>
      ))}
      {hasAudio ? <span className={badgeChip}>Audio</span> : null}
    </span>
  )
}

function ModelRow({
  opt,
  selected,
  active,
  favorite,
  onSelect,
  onToggleFavorite,
  onHover,
  listId,
  index,
  optionRef
}: {
  opt: ModelPickerOption
  selected: boolean
  active: boolean
  favorite: boolean
  onSelect: () => void
  onToggleFavorite: () => void
  onHover: () => void
  listId: string
  index: number
  optionRef: (el: HTMLElement | null) => void
}) {
  const parsed = parseModelSelectionKey(opt.value)
  return (
    <li
      id={`${listId}-opt-${opt.value}`}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      ref={optionRef}
      className={cn(
        'group',
        optionClass,
        selected && 'bg-surface-2 text-fg-strong',
        active && !selected && 'bg-surface'
      )}
      onClick={onSelect}
      onMouseEnter={onHover}
    >
      {parsed ? (
        <ProviderLogo
          id={parsed.provider}
          subProvider={opt.subProvider}
          size="sm"
          className="shrink-0 text-muted"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate leading-tight" title={opt.label}>
        {opt.label}
      </span>
      <CapabilityBadges meta={opt.meta} />
      <Tooltip content={favorite ? 'Remove from favorites' : 'Add to favorites'}>
        <button
          type="button"
          className={cn(
            'absolute top-1/2 right-7 z-[1] inline-grid size-5 -translate-y-1/2 place-items-center rounded text-muted vy-transition',
            favorite
              ? 'opacity-100 text-fg'
              : 'opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100'
          )}
          aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
          tabIndex={favorite ? 0 : -1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
        >
          <Icon name="star" size={14} weight={favorite ? 'fill' : 'bold'} />
        </button>
      </Tooltip>
      {selected ? (
        <Icon
          name="check"
          size={16}
          className="absolute top-1/2 right-2.5 shrink-0 -translate-y-1/2 text-fg"
        />
      ) : (
        <span className="absolute top-1/2 right-2.5 inline-block size-4 -translate-y-1/2" aria-hidden />
      )}
    </li>
  )
}

export function ModelPicker({
  providers,
  optionsByProvider,
  seedsByProvider,
  modelMetaByValue,
  provider,
  model,
  favoriteModels = [],
  recentModels = [],
  modelsWarning,
  serviceTier,
  onModelChange,
  onToggleFavorite,
  onServiceTierChange,
  onRefreshCatalog,
  onBrowseProvider,
  catalogLoading,
  disabled,
  className,
  triggerClassName,
  focusInput
}: {
  providers: ProviderId[]
  optionsByProvider: Record<ProviderId, ModelPickerOption[]>
  seedsByProvider: Record<ProviderId, ModelPickerOption[]>
  modelMetaByValue: Record<string, import('@shared/ipc').ModelInfo>
  provider: ProviderId
  model: string
  favoriteModels: string[]
  recentModels: string[]
  modelsWarning: string | null
  serviceTier: ServiceTier
  onModelChange: (provider: ProviderId, model: string) => void
  onToggleFavorite: (provider: ProviderId, model: string) => void
  onServiceTierChange: (tier: ServiceTier) => void
  onRefreshCatalog: () => void
  onBrowseProvider?: (provider: ProviderId) => void
  catalogLoading?: boolean
  disabled?: boolean
  className?: string
  triggerClassName?: string
  focusInput?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const [browsedProvider, setBrowsedProvider] = useState<ProviderId>(provider)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLElement | null>>([])
  const listId = useId()
  const panelId = useId()

  const modelValue = modelSelectionKey(provider, model)
  const providerMeta = PROVIDER_DEFAULTS.find((p) => p.id === provider)
  const displayName =
    optionsByProvider[provider]?.find((o) => o.value === modelValue)?.label ??
    formatModelDisplayName(model)

  const supportedTiers = supportedTiersForModel(
    provider,
    model,
    modelMetaByValue[modelValue]
  )

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (!next) {
        setQuery('')
        setActiveIndex(-1)
      }
    },
    [setOpen]
  )

  const { position, close } = useDropdownMenu({
    open,
    onOpenChange: handleOpenChange,
    triggerRef,
    panelRef,
    placement: 'up',
    align: 'start',
    disabled
  })

  useEffect(() => {
    if (!open) return
    const tab = readSessionTab(provider, providers)
    setBrowsedProvider(tab)
    onBrowseProvider?.(tab)
    const t = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open, provider, providers, onBrowseProvider])

  const selectBrowsedProvider = useCallback(
    (next: ProviderId) => {
      setBrowsedProvider(next)
      onBrowseProvider?.(next)
      try {
        sessionStorage.setItem(SESSION_TAB_KEY, next)
      } catch {
        // ignore
      }
    },
    [onBrowseProvider]
  )

  const globalSearchResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const hits: ModelPickerOption[] = []
    for (const p of providers) {
      for (const opt of optionsByProvider[p] ?? []) {
        if (
          opt.label.toLowerCase().includes(q) ||
          opt.value.toLowerCase().includes(q) ||
          (opt.group?.toLowerCase().includes(q) ?? false)
        ) {
          hits.push(opt)
        }
      }
    }
    return hits
  }, [query, providers, optionsByProvider])

  useEffect(() => {
    if (globalSearchResults?.length && query.trim()) {
      const first = parseModelSelectionKey(globalSearchResults[0].value)
      if (first) selectBrowsedProvider(first.provider)
    }
  }, [globalSearchResults, query, selectBrowsedProvider])

  const visibleOptions = useMemo(() => {
    if (globalSearchResults !== null) {
      return { mode: 'flat' as const, items: globalSearchResults }
    }
    const base = optionsByProvider[browsedProvider] ?? []
    const seedIds = new Set((seedsByProvider[browsedProvider] ?? []).map((o) => o.value))

    const favorites = favoriteModels
      .map((k) => resolvePickerOption(k, optionsByProvider, modelMetaByValue))
      .filter((o): o is ModelPickerOption => Boolean(o))
    const recent = recentModels
      .map((k) => resolvePickerOption(k, optionsByProvider, modelMetaByValue))
      .filter((o): o is ModelPickerOption => Boolean(o))
    const seeds = base.filter((o) => seedIds.has(o.value))
    const pinned = new Set([...favorites, ...recent, ...seeds].map((o) => o.value))
    const rest = base.filter((o) => !pinned.has(o.value))

    const sections: { header: string; items: ModelPickerOption[] }[] = []
    if (favorites.length) sections.push({ header: 'Favorites', items: favorites })
    if (recent.length) sections.push({ header: 'Recent', items: recent })
    if (seeds.length) sections.push({ header: 'Recommended', items: seeds })
    if (rest.length) sections.push({ header: 'All models', items: rest })
    return { mode: 'sections' as const, sections }
  }, [
    globalSearchResults,
    optionsByProvider,
    browsedProvider,
    favoriteModels,
    recentModels,
    seedsByProvider,
    modelMetaByValue
  ])

  const flatOptions = useMemo(() => {
    if (visibleOptions.mode === 'flat') return visibleOptions.items
    return visibleOptions.sections.flatMap((s) => s.items)
  }, [visibleOptions])

  const pickModel = useCallback(
    (value: string) => {
      const parsed = parseModelSelectionKey(value)
      if (!parsed) return
      onModelChange(parsed.provider, parsed.model)
      close(false)
      window.setTimeout(() => focusInput?.(), 0)
    },
    [onModelChange, close, focusInput]
  )

  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!flatOptions.length) return
      setActiveIndex((i) => (i < 0 ? 0 : (i + 1) % flatOptions.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!flatOptions.length) return
      setActiveIndex((i) =>
        i < 0 ? flatOptions.length - 1 : (i - 1 + flatOptions.length) % flatOptions.length
      )
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = flatOptions[activeIndex]
      if (opt) pickModel(opt.value)
    }
  }

  const panel =
    open && position
      ? (() => {
          const pos = position
          const { left: panelLeft, width: panelWidth, maxHeight } = clampComposerDropdownPanel({
            position: pos,
            maxWidthPx: PANEL_MAX_PX,
            minHeightPx: 240
          })
          return createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="listbox"
            aria-label="Select model"
            className="fixed z-dropdown flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-menu animate-fade-in"
            style={{
              top: pos.placement === 'up' ? undefined : pos.top,
              bottom:
                pos.placement === 'up' ? window.innerHeight - pos.top : undefined,
              left: panelLeft,
              width: panelWidth,
              maxWidth: panelWidth,
              maxHeight
            }}
            onKeyDown={onListKeyDown}
          >
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <SearchInput
                  ref={searchRef}
                  inputClassName="min-h-7 text-xs"
                  placeholder="Search all models"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActiveIndex(0)
                  }}
                  aria-label="Search models"
                />
              </div>
              <button
                type="button"
                className="inline-grid size-7 shrink-0 place-items-center rounded-xl text-muted vy-transition hover:bg-surface hover:text-fg disabled:opacity-50"
                aria-label="Refresh model catalog"
                disabled={catalogLoading}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onRefreshCatalog()}
              >
                <span className={cn('text-sm', catalogLoading && 'animate-spin')}>↻</span>
              </button>
            </div>

            {modelsWarning ? (
              <p className="m-0 shrink-0 border-b border-border bg-surface px-3 py-1.5 text-[10px] leading-snug text-muted">
                {modelsWarning}
              </p>
            ) : null}

            <div className="sidebar-scroll-x flex shrink-0 gap-1 border-b border-border px-2 py-1.5">
              {providers.map((p) => {
                const meta = PROVIDER_DEFAULTS.find((d) => d.id === p)
                const active = browsedProvider === p
                return (
                  <button
                    key={p}
                    type="button"
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] leading-tight vy-transition',
                      active
                        ? 'bg-surface-2 text-fg-strong'
                        : 'text-secondary hover:bg-surface hover:text-fg'
                    )}
                    aria-pressed={active}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectBrowsedProvider(p)}
                  >
                    <ProviderLogo id={p} size="sm" />
                    <span>{meta?.label ?? p}</span>
                  </button>
                )
              })}
            </div>

            <ul
              id={listId}
              className="sidebar-scroll m-0 min-h-0 flex-1 list-none p-1"
              role="presentation"
            >
              {flatOptions.length === 0 ? (
                <li className="px-2.5 py-2 text-xs text-muted">No matches</li>
              ) : visibleOptions.mode === 'flat' ? (
                flatOptions.map((opt, index) => (
                  <ModelRow
                    key={opt.value}
                    opt={opt}
                    selected={opt.value === modelValue}
                    active={index === activeIndex}
                    favorite={favoriteModels.includes(opt.value)}
                    onSelect={() => pickModel(opt.value)}
                    onHover={() => setActiveIndex(index)}
                    onToggleFavorite={() => {
                      const parsed = parseModelSelectionKey(opt.value)
                      if (parsed) onToggleFavorite(parsed.provider, parsed.model)
                    }}
                    listId={listId}
                    index={index}
                    optionRef={(el) => {
                      optionRefs.current[index] = el
                    }}
                  />
                ))
              ) : (
                visibleOptions.sections.map((section) => (
                  <li key={section.header} role="presentation">
                    <div className="px-2.5 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-secondary">
                      {section.header}
                    </div>
                    <ul className="m-0 list-none p-0" role="group" aria-label={section.header}>
                      {section.items.map((opt) => {
                        const index = flatOptions.findIndex((o) => o.value === opt.value)
                        return (
                          <ModelRow
                            key={opt.value}
                            opt={opt}
                            selected={opt.value === modelValue}
                            active={index === activeIndex}
                            favorite={favoriteModels.includes(opt.value)}
                            onSelect={() => pickModel(opt.value)}
                            onHover={() => setActiveIndex(index)}
                            onToggleFavorite={() => {
                              const parsed = parseModelSelectionKey(opt.value)
                              if (parsed) onToggleFavorite(parsed.provider, parsed.model)
                            }}
                            listId={listId}
                            index={index}
                            optionRef={(el) => {
                              optionRefs.current[index] = el
                            }}
                          />
                        )
                      })}
                    </ul>
                  </li>
                ))
              )}
            </ul>

            {supportedTiers.length > 0 ? (
              <div className="shrink-0 border-t border-border px-3 py-2">
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-secondary">
                  Speed
                </p>
                <div className="flex flex-wrap gap-1">
                  {supportedTiers.map((tier) => (
                    <button
                      key={tier}
                      type="button"
                      className={cn(
                        'rounded-lg px-2 py-1 text-xs vy-transition',
                        serviceTier === tier
                          ? 'bg-surface-2 text-fg-strong'
                          : 'text-muted hover:bg-surface hover:text-fg'
                      )}
                      title={SERVICE_TIER_DESCRIPTIONS[tier]}
                      aria-pressed={serviceTier === tier}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onServiceTierChange(tier)}
                    >
                      {SERVICE_TIER_LABELS[tier]}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>,
          document.body
        )
      })()
      : null

  return (
    <div className={cn('relative flex h-7 min-w-0 items-center', className)}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label="Select model"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={`${providerMeta?.label ?? provider} · ${displayName}`}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <ProviderLogo id={provider} size="sm" className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate leading-tight text-fg">{displayName}</span>
        <Icon
          name="chevron"
          size={12}
          className={cn('shrink-0 text-muted vy-transition', open && 'rotate-180')}
        />
      </button>
      {panel}
    </div>
  )
}
