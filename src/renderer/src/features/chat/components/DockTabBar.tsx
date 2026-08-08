import { useMemo, useState, type RefObject } from 'react'
import { ActionMenu, IconButton, Tooltip, cn } from '@renderer/lib/ui'
import { Icon, type IconName } from '@renderer/lib/icons'
import type { ChatRightPanelId, DockImmersiveTabId } from '@renderer/lib/utils/layout'
import { DOCK_PANELS, dockPanelDef } from '@renderer/lib/utils/dockPanels'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'

export type DockTabItem = {
  id: DockImmersiveTabId
  label: string
  icon: IconName
  /** When false, omit the close control (Agent tab). Defaults to true for panel tabs. */
  closable?: boolean
}

const ADDABLE: DockTabItem[] = DOCK_PANELS.map((p) => ({
  id: p.id,
  label: p.label,
  icon: p.icon
}))

export const AGENT_DOCK_TAB: DockTabItem = {
  id: 'agent',
  label: 'Agent',
  icon: 'bot',
  closable: false
}

/**
 * Cursor-style horizontal tabs above the active right dock panel.
 * Immersive variant: pill active chip, Agent tab, + add — unified with the agent column.
 */
export function DockTabBar({
  active,
  tabs,
  onSelect,
  onCloseTab,
  onOpenPanel,
  expanded,
  onToggleExpanded,
  variant = 'dock',
  terminalSessionBarHostRef,
  embeddedInTitleBar = false,
  className
}: {
  active: DockImmersiveTabId
  tabs: DockTabItem[]
  onSelect: (id: DockImmersiveTabId) => void
  onCloseTab: (id: ChatRightPanelId) => void
  onOpenPanel: (id: ChatRightPanelId) => void
  expanded?: boolean
  onToggleExpanded?: () => void
  variant?: 'dock' | 'immersive'
  /** Host for {@link TerminalSessionBar} when the terminal panel is active. */
  terminalSessionBarHostRef?: RefObject<HTMLDivElement | null>
  /** Side-dock tabs portaled into the title bar — fill host height, no second border. */
  embeddedInTitleBar?: boolean
  className?: string
}) {
  const [addOpen, setAddOpen] = useState(false)
  const immersive = variant === 'immersive'
  const inTitleBar = immersive || embeddedInTitleBar

  const openIds = useMemo(() => new Set(tabs.map((t) => t.id)), [tabs])
  const addable = useMemo(() => ADDABLE.filter((t) => !openIds.has(t.id)), [openIds])
  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs])
  const addItems = useMemo(
    () =>
      addable.map((item) => ({
        id: item.id,
        label: item.label,
        icon: item.icon,
        onSelect: () => {
          if (item.id !== 'agent') onOpenPanel(item.id)
        }
      })),
    [addable, onOpenPanel]
  )

  const addMenu =
    addable.length > 0 ? (
      <ActionMenu
        open={addOpen}
        onOpenChange={setAddOpen}
        placement="down"
        align={immersive ? 'start' : 'end'}
        aria-label="Add panel"
        items={addItems}
        trigger={(props) => (
          <IconButton
            ref={props.ref}
            icon="plus"
            label="Add panel"
            size="sm"
            variant="bare"
            className="text-muted"
            aria-expanded={props['aria-expanded']}
            aria-controls={props['aria-controls']}
            aria-haspopup={props['aria-haspopup']}
            onClick={props.onClick}
          />
        )}
      />
    ) : null

  return (
    <div
      className={cn(
        'flex min-w-0 shrink-0 flex-row items-center gap-0.5 bg-bg',
        inTitleBar
          ? 'h-full w-full border-0 px-1 py-0'
          : 'border-b border-border/40 px-1 py-0.5',
        className
      )}
      data-dock-tab-bar
      data-dock-tab-variant={variant}
      data-dock-embedded={embeddedInTitleBar ? '1' : undefined}
    >
      {/* Tabs hug content; scroll only when they overflow — never stretch a scrollport
          across the empty titlebar (scrollbar dead zone + vertical clip). */}
      <div
        className={cn(
          'flex min-w-0 flex-row items-center gap-1',
          inTitleBar
            ? 'app-region-no-drag max-w-full shrink overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0'
            : 'sidebar-scroll-x flex-1 overflow-x-auto'
        )}
        role="tablist"
        aria-label={immersive ? 'Agent and panels' : 'Panels'}
        onKeyDown={(e) =>
          handleTabListKeyDown(e, {
            tabs: tabIds,
            activeId: active,
            onSelect: (id) => onSelect(id as DockImmersiveTabId)
          })
        }
      >
        {tabs.map((tab) => {
          const selected = tab.id === active
          const closable = tab.closable !== false && tab.id !== 'agent'
          return (
            <div
              key={tab.id}
              className={cn(
                'group inline-flex h-7 max-w-[9rem] shrink-0 items-center gap-0.5',
                immersive ? 'rounded-full' : 'rounded-md',
                selected ? 'bg-surface' : 'hover:bg-surface/60',
                closable ? 'pl-2.5 pr-1' : 'px-2.5'
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`dock-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                className={cn(
                  'inline-flex h-full min-w-0 flex-1 items-center gap-1.5 text-xs leading-tight focus-visible:vy-focus-ring',
                  immersive ? 'rounded-full' : 'rounded-md',
                  selected ? 'font-medium text-fg' : 'text-secondary hover:text-fg'
                )}
                onKeyDown={(e) => {
                  if (e.key === 'Delete' && closable && tab.id !== 'agent') {
                    e.preventDefault()
                    onCloseTab(tab.id)
                  }
                }}
                onClick={() => onSelect(tab.id)}
              >
                <Icon
                  name={tab.icon}
                  size={14}
                  className={cn('shrink-0 self-center', selected ? 'text-fg' : 'text-secondary')}
                />
                <span className="min-w-0 truncate leading-tight">{tab.label}</span>
              </button>
              {closable ? (
                <Tooltip content={`Close ${tab.label}`}>
                  <button
                    type="button"
                    className={cn(
                      'inline-grid size-5 shrink-0 place-items-center rounded-full focus-visible:opacity-100 focus-visible:vy-focus-ring',
                      selected
                        ? 'opacity-70 hover:bg-surface-2 hover:opacity-100'
                        : 'opacity-0 hover:bg-surface-2 group-hover:opacity-100 group-focus-within:opacity-100'
                    )}
                    aria-label={`Close ${tab.label}`}
                    aria-keyshortcuts="Delete"
                    tabIndex={selected ? 0 : -1}
                    onClick={() => {
                      if (tab.id !== 'agent') onCloseTab(tab.id)
                    }}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </Tooltip>
              ) : null}
            </div>
          )
        })}
        {terminalSessionBarHostRef ? (
          <>
            <span className="mx-0.5 h-4 w-px shrink-0 bg-border/40" aria-hidden />
            <div
              ref={terminalSessionBarHostRef}
              className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
              data-terminal-session-bar-host
            />
          </>
        ) : null}
      </div>

      {/* Keep + outside the scrollport so the menu can portal below the h-9 titlebar. */}
      {immersive ? addMenu : null}

      {immersive ? (
        <div
          className="app-region-drag min-w-3 flex-1 self-stretch"
          aria-hidden
          data-titlebar-drag-spacer
          onDoubleClick={() => void window.vyotiq?.windowMaximize()}
        />
      ) : null}

      <div
        className={cn(
          'relative flex shrink-0 items-center gap-0.5',
          immersive && 'app-region-no-drag pr-2',
          embeddedInTitleBar && 'app-region-no-drag'
        )}
      >
        {!immersive ? addMenu : null}
        {onToggleExpanded ? (
          <IconButton
            icon={expanded ? 'sidebar' : 'maximize'}
            label={expanded ? 'Collapse panel' : 'Expand panel'}
            variant="bare"
            size="sm"
            className="text-muted"
            onClick={onToggleExpanded}
          />
        ) : null}
      </div>
    </div>
  )
}

export function defaultDockTab(id: ChatRightPanelId, prNumber?: number | null): DockTabItem {
  const def = dockPanelDef(id)
  if (id === 'pr' && prNumber != null) {
    return { id, label: `PR #${prNumber}`, icon: def.icon }
  }
  return { id, label: def.label, icon: def.icon }
}
