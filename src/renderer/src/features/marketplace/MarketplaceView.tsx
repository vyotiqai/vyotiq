import { useEffect, useRef, useState } from 'react'
import type { MarketplaceCatalogEntry, Settings, WorkspaceSettingsOverride } from '@shared/ipc'
import { CHAT_GUTTER, MARKETPLACE_COLUMN, SIDEBAR_NAV_ACTIVE } from '@renderer/lib/utils/layout'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'
import { Button, PageHeader, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { useMarketplaceController } from './useMarketplaceController'
import { MarketplaceHome } from './MarketplaceHome'
import { MarketplaceDetail } from './MarketplaceDetail'
import { MarketplaceManage } from './MarketplaceManage'

const SECTION_TABS = ['browse', 'manage'] as const
type SectionTab = (typeof SECTION_TABS)[number]

const PANEL_IDS: Record<SectionTab, string> = {
  browse: 'marketplace-browse-panel',
  manage: 'marketplace-manage-panel'
}

type Pane =
  | { kind: 'home' }
  | { kind: 'detail'; entryId: string; fallback: MarketplaceCatalogEntry }
  | {
      kind: 'manage'
      returnTo?: { entryId: string; fallback: MarketplaceCatalogEntry }
    }

export function MarketplaceView({
  settings,
  onUpdate,
  onReloadSettings,
  activeWorkspacePath,
  settingsOverridesByPath,
  onSetSettingsOverride,
  onClose,
  focusServerId,
  onFocusServerConsumed
}: {
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  onReloadSettings?: () => Promise<void>
  activeWorkspacePath?: string | null
  settingsOverridesByPath?: Record<string, WorkspaceSettingsOverride>
  onSetSettingsOverride?: (
    path: string,
    override: WorkspaceSettingsOverride | null
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  onClose?: () => void
  focusServerId?: string | null
  onFocusServerConsumed?: () => void
}) {
  const [pane, setPane] = useState<Pane>(() =>
    focusServerId ? { kind: 'manage' } : { kind: 'home' }
  )
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [manageFocusServerId, setManageFocusServerId] = useState<string | null>(
    focusServerId ?? null
  )
  const controller = useMarketplaceController({
    settings,
    onUpdate,
    onReloadSettings,
    activeWorkspacePath
  })
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    window.setTimeout(() => closeRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    if (!focusServerId) return
    setPane({ kind: 'manage' })
    setManageFocusServerId(focusServerId)
    onFocusServerConsumed?.()
  }, [focusServerId, onFocusServerConsumed])

  const detailEntry =
    pane.kind === 'detail'
      ? (controller.catalog.find((e) => e.id === pane.entryId) ?? pane.fallback)
      : null

  const openDetail = (entry: MarketplaceCatalogEntry): void => {
    setSelectedEntryId(entry.id)
    setPane({ kind: 'detail', entryId: entry.id, fallback: entry })
  }

  const openBrowse = (): void => {
    setManageFocusServerId(null)
    setPane({ kind: 'home' })
  }

  const openManage = (returnTo?: { entryId: string; fallback: MarketplaceCatalogEntry }): void => {
    setPane(returnTo ? { kind: 'manage', returnTo } : { kind: 'manage' })
  }

  const browseActive = pane.kind === 'home' || pane.kind === 'detail'
  const manageActive = pane.kind === 'manage'
  const sectionTab: SectionTab = manageActive ? 'manage' : 'browse'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg animate-fade-in">
      <PageHeader
        bordered={false}
        className={cn('shrink-0 border-b border-border/30 bg-bg py-3', CHAT_GUTTER)}
        title="Marketplace"
        description="MCP servers, skills, and plugins for the agent."
        trailing={
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div
              className="flex gap-0.5"
              role="tablist"
              aria-label="Marketplace sections"
              onKeyDown={(e) =>
                handleTabListKeyDown(e, {
                  tabs: [...SECTION_TABS],
                  activeId: sectionTab,
                  onSelect: (id) => {
                    if (id === 'browse') openBrowse()
                    else openManage()
                  }
                })
              }
            >
              <Button
                id="marketplace-tab-browse"
                role="tab"
                aria-selected={browseActive}
                aria-controls={PANEL_IDS.browse}
                tabIndex={browseActive ? 0 : -1}
                variant="ghost"
                className={cn('min-h-7 px-2.5', browseActive && SIDEBAR_NAV_ACTIVE)}
                onClick={openBrowse}
              >
                Browse
              </Button>
              <Button
                id="marketplace-tab-manage"
                role="tab"
                aria-selected={manageActive}
                aria-controls={PANEL_IDS.manage}
                tabIndex={manageActive ? 0 : -1}
                variant="ghost"
                className={cn('min-h-7 px-2.5', manageActive && SIDEBAR_NAV_ACTIVE)}
                onClick={() => openManage()}
              >
                Manage
              </Button>
            </div>
            {onClose ? (
              <button
                ref={closeRef}
                type="button"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-muted vy-transition hover:bg-surface/50 hover:text-fg focus-visible:vy-focus-ring"
                onClick={onClose}
              >
                <Icon name="chevron" size={14} className="-rotate-90" />
                Close
              </button>
            ) : null}
          </div>
        }
      />

      <div className={cn('min-h-0 flex-1 overflow-y-auto', CHAT_GUTTER, 'py-5')}>
        <div className={MARKETPLACE_COLUMN}>
          {browseActive ? (
            <div
              id={PANEL_IDS.browse}
              role="tabpanel"
              aria-labelledby="marketplace-tab-browse"
            >
              {pane.kind === 'home' ? (
                <MarketplaceHome
                  controller={controller}
                  selectedEntryId={selectedEntryId}
                  onOpenDetail={openDetail}
                  onOpenManage={() => openManage()}
                />
              ) : null}
              {pane.kind === 'detail' && detailEntry ? (
                <MarketplaceDetail
                  entry={detailEntry}
                  controller={controller}
                  onBack={openBrowse}
                  onOpenManage={() =>
                    openManage({ entryId: detailEntry.id, fallback: detailEntry })
                  }
                />
              ) : null}
            </div>
          ) : null}
          {pane.kind === 'manage' ? (
            <div
              id={PANEL_IDS.manage}
              role="tabpanel"
              aria-labelledby="marketplace-tab-manage"
            >
              <MarketplaceManage
                controller={controller}
                settings={settings}
                activeWorkspacePath={activeWorkspacePath}
                settingsOverridesByPath={settingsOverridesByPath}
                onSetSettingsOverride={onSetSettingsOverride}
                focusServerId={manageFocusServerId}
                onBack={() => {
                  setManageFocusServerId(null)
                  if (pane.returnTo) {
                    setSelectedEntryId(pane.returnTo.entryId)
                    setPane({
                      kind: 'detail',
                      entryId: pane.returnTo.entryId,
                      fallback: pane.returnTo.fallback
                    })
                  } else {
                    setPane({ kind: 'home' })
                  }
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
