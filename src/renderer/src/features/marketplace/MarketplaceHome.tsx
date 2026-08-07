import { useMemo, useState } from 'react'
import type {
  MarketplaceCatalogEntry,
  MarketplaceInstalledItem,
  MarketplaceKind,
  McpServerStatus
} from '@shared/ipc'
import { Button, Input, cn } from '@renderer/lib/ui'
import { PackageIcon } from './PackageIcon'
import { MarketplaceFeedbackBanner } from './MarketplaceFeedbackBanner'
import { categoryTitle, kindLabel } from './marketplaceLabels'
import {
  installedActionLabel,
  packageActivity,
  type PackageActivity
} from './packageActivity'
import type { MarketplaceController } from './useMarketplaceController'

const CATEGORY_INITIAL_VISIBLE = 4

const KIND_ORDER: MarketplaceKind[] = ['mcp', 'skill', 'plugin']

const CARD_BUTTON =
  'vy-transition hover:border-border-strong hover:bg-surface-2 focus-visible:vy-focus-ring'

const CARD_SELECTED = 'border-border-strong bg-surface-2'

function activityFor(
  entry: MarketplaceCatalogEntry,
  installedById: Map<string, MarketplaceInstalledItem>,
  mcpStatusById: Map<string, McpServerStatus>
): PackageActivity {
  return packageActivity(entry, installedById.get(entry.id), mcpStatusById.get(entry.id))
}

function catalogEntryForInstalled(
  item: MarketplaceInstalledItem,
  catalogById: Map<string, MarketplaceCatalogEntry>
): MarketplaceCatalogEntry {
  const fromCatalog = catalogById.get(item.id)
  if (fromCatalog) return fromCatalog
  return {
    id: item.id,
    name: item.name,
    version: item.version,
    description: item.description,
    kind: item.kind,
    source: item.installSource === 'bundled' ? 'bundled' : 'remote',
    installable: true
  }
}

function matchesBrowseFilters(
  entry: { id: string; name: string; description: string; kind: MarketplaceKind },
  kindFilter: MarketplaceKind | 'all',
  query: string
): boolean {
  if (kindFilter !== 'all' && entry.kind !== kindFilter) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    entry.id.toLowerCase().includes(q) ||
    entry.name.toLowerCase().includes(q) ||
    entry.description.toLowerCase().includes(q)
  )
}

function PackageCard({
  entry,
  activity,
  selected,
  formLocked,
  showAdd,
  onOpen,
  onAdd
}: {
  entry: MarketplaceCatalogEntry
  activity: PackageActivity
  selected: boolean
  formLocked?: boolean
  showAdd?: boolean
  onOpen: () => void
  onAdd?: () => void
}) {
  const comingSoon = activity.kind === 'coming-soon'
  const installed = activity.kind !== 'available' && activity.kind !== 'coming-soon'
  const locked = Boolean(formLocked)

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border border-border bg-surface px-3 py-3',
        selected && CARD_SELECTED
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'page' : undefined}
        aria-label={entry.name}
        title={entry.name}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-3 text-left',
          CARD_BUTTON,
          'border-0 bg-transparent p-0 hover:bg-transparent'
        )}
      >
        <PackageIcon name={entry.name} iconUrl={entry.iconUrl} size={40} />
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-sm font-medium text-fg" title={entry.name}>
            {entry.name}
          </p>
          <p
            className="m-0 mt-0.5 line-clamp-2 text-xs text-secondary"
            title={entry.description || undefined}
          >
            {entry.description || '—'}
          </p>
          <p
            className={cn('m-0 mt-1 truncate text-caption text-muted', activity.className)}
            title={[
              kindLabel(entry.kind),
              entry.publisher,
              activity.kind !== 'available' ? activity.label : null
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            {kindLabel(entry.kind)}
            {entry.publisher ? ` · ${entry.publisher}` : ''}
            {activity.kind !== 'available' ? ` · ${activity.label}` : ''}
          </p>
        </div>
      </button>
      {showAdd ? (
        comingSoon ? (
          <Button variant="subtle" disabled className="shrink-0 self-center">
            Coming soon
          </Button>
        ) : installed ? (
          <Button
            variant="subtle"
            disabled
            className={cn('shrink-0 self-center', activity.className)}
          >
            {installedActionLabel(activity)}
          </Button>
        ) : (
          <Button
            variant="subtle"
            className="shrink-0 self-center"
            pending={locked}
            disabled={locked}
            onClick={(e) => {
              e.stopPropagation()
              onAdd?.()
            }}
          >
            {locked ? 'Installing…' : 'Add'}
          </Button>
        )
      ) : null}
    </div>
  )
}

function CategorySection({
  category,
  entries,
  installedById,
  mcpStatusById,
  selectedEntryId,
  onOpen
}: {
  category: string
  entries: MarketplaceCatalogEntry[]
  installedById: Map<string, MarketplaceInstalledItem>
  mcpStatusById: Map<string, McpServerStatus>
  selectedEntryId: string | null
  onOpen: (entry: MarketplaceCatalogEntry) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? entries : entries.slice(0, CATEGORY_INITIAL_VISIBLE)
  const hasMore = entries.length > CATEGORY_INITIAL_VISIBLE

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-medium text-fg">{categoryTitle(category)}</h2>
        {hasMore ? (
          <Button
            variant="subtle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : 'Show more'}
          </Button>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {visible.map((entry) => (
          <PackageCard
            key={`${entry.source}-${entry.id}`}
            entry={entry}
            activity={activityFor(entry, installedById, mcpStatusById)}
            selected={selectedEntryId === entry.id}
            onOpen={() => onOpen(entry)}
          />
        ))}
      </div>
    </section>
  )
}

export function MarketplaceHome({
  controller,
  selectedEntryId,
  onOpenDetail,
  onOpenManage
}: {
  controller: MarketplaceController
  selectedEntryId: string | null
  onOpenDetail: (entry: MarketplaceCatalogEntry) => void
  onOpenManage: () => void
}) {
  const {
    catalog,
    catalogLoading,
    installed,
    mcpStatusById,
    kindFilter,
    setKindFilter,
    query,
    setQuery,
    feedback,
    formLocked,
    installFromCatalog,
    refreshCatalog
  } = controller

  const installedById = useMemo(() => {
    const map = new Map<string, MarketplaceInstalledItem>()
    for (const item of installed.items) map.set(item.id, item)
    return map
  }, [installed.items])

  const catalogById = useMemo(() => {
    const map = new Map<string, MarketplaceCatalogEntry>()
    for (const entry of catalog) map.set(entry.id, entry)
    return map
  }, [catalog])

  const installedEntries = useMemo(() => {
    const entries = installed.items
      .map((item) => catalogEntryForInstalled(item, catalogById))
      .filter((entry) => matchesBrowseFilters(entry, kindFilter, query))
    entries.sort((a, b) => {
      const ki = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      if (ki !== 0) return ki
      return a.name.localeCompare(b.name)
    })
    return entries
  }, [installed.items, catalogById, kindFilter, query])

  const featured = useMemo(
    () =>
      catalog
        .filter((e) => e.sections?.includes('featured') && !installedById.has(e.id))
        .sort((a, b) => (a.featuredRank ?? 999) - (b.featuredRank ?? 999)),
    [catalog, installedById]
  )

  const featuredIds = useMemo(() => new Set(featured.map((e) => e.id)), [featured])

  const byCategory = useMemo(() => {
    const map = new Map<string, MarketplaceCatalogEntry[]>()
    for (const entry of catalog) {
      if (installedById.has(entry.id) || featuredIds.has(entry.id)) continue
      const key = entry.category?.trim() || 'other'
      const list = map.get(key) ?? []
      list.push(entry)
      map.set(key, list)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [catalog, featuredIds, installedById])

  const filteredEmpty = Boolean(query.trim()) || kindFilter !== 'all'
  const hasBrowseContent =
    installedEntries.length > 0 || featured.length > 0 || byCategory.length > 0

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[180px] flex-1"
          placeholder="Search plugins, skills, MCPs…"
          value={query}
          aria-label="Search marketplace"
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg"
          value={kindFilter}
          aria-label="Filter by kind"
          onChange={(e) => setKindFilter(e.target.value as MarketplaceKind | 'all')}
        >
          <option value="all">All</option>
          <option value="mcp">MCP</option>
          <option value="skill">Skills</option>
          <option value="plugin">Plugins</option>
        </select>
        <Button
          variant="subtle"
          disabled={formLocked || catalogLoading}
          onClick={() => void refreshCatalog()}
        >
          {catalogLoading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <MarketplaceFeedbackBanner feedback={feedback} />

      {catalogLoading && catalog.length === 0 && installed.items.length === 0 ? (
        <p className="m-0 text-sm text-muted">Loading catalog…</p>
      ) : !hasBrowseContent ? (
        filteredEmpty ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-3">
            <p className="m-0 text-sm text-fg">No matching packages in the curated catalog.</p>
            <p className="m-0 text-xs text-secondary">
              External MCPs (GitHub URLs, npm packages, npx/uvx commands, or Cursor/Claude JSON) are
              added under Manage → Add — they won’t appear in this search until installed from the
              catalog or added manually.
            </p>
            <div>
              <Button variant="subtle" onClick={onOpenManage}>
                Open Manage to add
              </Button>
            </div>
          </div>
        ) : (
          <p className="m-0 text-sm text-muted">
            No packages in catalog. Open Manage to add MCP servers, or configure a registry under
            Settings → Registry.
          </p>
        )
      ) : (
        <>
          {installedEntries.length > 0 ? (
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="m-0 text-sm font-medium text-fg">Installed</h2>
                <Button variant="subtle" onClick={onOpenManage}>
                  Manage
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {installedEntries.map((entry) => (
                  <PackageCard
                    key={`installed-${entry.source}-${entry.id}`}
                    entry={entry}
                    activity={activityFor(entry, installedById, mcpStatusById)}
                    selected={selectedEntryId === entry.id}
                    showAdd
                    onOpen={() => onOpenDetail(entry)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {featured.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="m-0 text-sm font-medium text-fg">Featured</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {featured.map((entry) => (
                  <PackageCard
                    key={`${entry.source}-${entry.id}`}
                    entry={entry}
                    activity={activityFor(entry, installedById, mcpStatusById)}
                    selected={selectedEntryId === entry.id}
                    formLocked={formLocked}
                    showAdd
                    onOpen={() => onOpenDetail(entry)}
                    onAdd={() => void installFromCatalog(entry)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {byCategory.map(([category, entries]) => (
            <CategorySection
              key={category}
              category={category}
              entries={entries}
              installedById={installedById}
              mcpStatusById={mcpStatusById}
              selectedEntryId={selectedEntryId}
              onOpen={onOpenDetail}
            />
          ))}
        </>
      )}
    </div>
  )
}
