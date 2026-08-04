import { useEffect, useState } from 'react'
import type { Settings, WorkspaceSettingsOverride } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'
import { MarketplaceFeedbackBanner } from './MarketplaceFeedbackBanner'
import { MarketplaceInstalledList } from './MarketplaceInstalledList'
import { MarketplaceAddPanel } from './MarketplaceAddPanel'
import type { MarketplaceController } from './useMarketplaceController'

type ManageTab = 'installed' | 'add'

export function MarketplaceManage({
  controller,
  settings,
  activeWorkspacePath,
  settingsOverridesByPath,
  onSetSettingsOverride,
  onBack,
  focusServerId
}: {
  controller: MarketplaceController
  settings: Settings
  activeWorkspacePath?: string | null
  settingsOverridesByPath?: Record<string, WorkspaceSettingsOverride>
  onSetSettingsOverride?: (
    path: string,
    override: WorkspaceSettingsOverride | null
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  onBack: () => void
  focusServerId?: string | null
}) {
  const [tab, setTab] = useState<ManageTab>('installed')
  const { formLocked, feedback, setFeedback } = controller

  useEffect(() => {
    if (!focusServerId) return
    setTab('installed')
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-mcp-server-id="${CSS.escape(focusServerId)}"]`
      )
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      el?.focus?.()
    }, 50)
    return () => window.clearTimeout(t)
  }, [focusServerId])

  const workspaceOverride =
    activeWorkspacePath && settingsOverridesByPath
      ? settingsOverridesByPath[activeWorkspacePath]
      : undefined

  const setWorkspaceEnable = async (
    kind: 'mcp' | 'skills' | 'plugins',
    id: string,
    enabled: boolean
  ) => {
    if (!activeWorkspacePath || !onSetSettingsOverride) return
    const prev = workspaceOverride ?? { useOverride: false as const }
    const marketplaceOverrides = {
      ...(prev.marketplaceOverrides ?? {}),
      [kind]: {
        ...(prev.marketplaceOverrides?.[kind] ?? {}),
        [id]: enabled
      }
    }
    const res = await onSetSettingsOverride(activeWorkspacePath, {
      ...prev,
      marketplaceOverrides
    })
    if (!res.ok) setFeedback({ kind: 'error', text: res.error })
  }

  const clearWorkspaceEnable = async (
    kind: 'mcp' | 'skills' | 'plugins',
    id: string
  ) => {
    if (!activeWorkspacePath || !onSetSettingsOverride || !workspaceOverride) return
    const kindMap = { ...(workspaceOverride.marketplaceOverrides?.[kind] ?? {}) }
    if (!Object.prototype.hasOwnProperty.call(kindMap, id)) return
    delete kindMap[id]
    const marketplaceOverrides = {
      ...(workspaceOverride.marketplaceOverrides ?? {}),
      [kind]: kindMap
    }
    const res = await onSetSettingsOverride(activeWorkspacePath, {
      ...workspaceOverride,
      marketplaceOverrides
    })
    if (!res.ok) setFeedback({ kind: 'error', text: res.error })
  }

  const workspaceEnabledForId = (
    kind: 'mcp' | 'skills' | 'plugins',
    id: string
  ): boolean | undefined => {
    const map = workspaceOverride?.marketplaceOverrides?.[kind]
    if (map && Object.prototype.hasOwnProperty.call(map, id)) return map[id]
    return undefined
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex items-center gap-1.5 text-xs text-muted" aria-label="Breadcrumb">
          <button
            type="button"
            className="text-secondary vy-transition hover:text-fg focus-visible:vy-focus-ring"
            onClick={onBack}
          >
            Marketplace
          </button>
          <Icon name="chevronRight" size={12} className="text-muted" />
          <span className="text-fg">Manage</span>
        </nav>
        <div
          className="flex flex-wrap gap-1"
          role="tablist"
          aria-label="Manage marketplace"
          onKeyDown={(e) =>
            handleTabListKeyDown(e, {
              tabs: ['installed', 'add'],
              activeId: tab,
              onSelect: (id) => setTab(id as ManageTab)
            })
          }
        >
          {(['installed', 'add'] as ManageTab[]).map((t) => (
            <Button
              key={t}
              id={`marketplace-manage-tab-${t}`}
              role="tab"
              aria-selected={tab === t}
              aria-controls={`marketplace-manage-panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              variant="subtle"
              className={tab === t ? 'bg-surface-2 text-fg-strong' : undefined}
              disabled={formLocked}
              onClick={() => setTab(t)}
            >
              {t === 'installed' ? 'Installed' : 'Add'}
            </Button>
          ))}
        </div>
      </div>

      {activeWorkspacePath && onSetSettingsOverride ? (
        <p className="m-0 rounded-md border border-border bg-surface px-2.5 py-2 text-xs text-secondary">
          Force on/off enables workspace overrides for this workspace and overrides global package
          enablement for agent runs here. Global MCP connections stay up for other workspaces
          (Settings → General → Workspaces).
        </p>
      ) : null}

      <MarketplaceFeedbackBanner feedback={feedback} />

      {tab === 'installed' ? (
        <div
          id="marketplace-manage-panel-installed"
          role="tabpanel"
          aria-labelledby="marketplace-manage-tab-installed"
        >
          <MarketplaceInstalledList
            controller={controller}
            settings={settings}
            activeWorkspacePath={activeWorkspacePath}
            canOverride={!!onSetSettingsOverride}
            setWorkspaceEnable={setWorkspaceEnable}
            clearWorkspaceEnable={clearWorkspaceEnable}
            workspaceEnabledForId={workspaceEnabledForId}
          />
        </div>
      ) : null}

      {tab === 'add' ? (
        <div
          id="marketplace-manage-panel-add"
          role="tabpanel"
          aria-labelledby="marketplace-manage-tab-add"
        >
          <MarketplaceAddPanel controller={controller} onInstalled={() => setTab('installed')} />
        </div>
      ) : null}
    </div>
  )
}
