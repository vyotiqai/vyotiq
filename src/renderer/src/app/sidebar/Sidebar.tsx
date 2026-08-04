import { cn, NavItem } from '@renderer/lib/ui'
import { useWorkspaceHotUi } from '@renderer/lib/hooks/workspaceHotUiStore'
import { useEffect, useState } from 'react'
import {
  SIDEBAR_CONTAINER,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_COLLAPSED,
  SIDEBAR_WIDTH_COLLAPSED_DARWIN,
  SIDEBAR_WIDTH_PX
} from '@renderer/lib/utils/layout'
import { ChatList } from './ChatList'
import { SidebarCollapsedHeader, SidebarTopBar } from './SidebarTopBar'
import type { SidebarProps } from './types'
import { useSidebarChats } from './useSidebarChats'

export function Sidebar({
  view,
  onDismissRunsError,
  sessionQuery: sessionQueryProp,
  searchRef,
  hasWorkspace,
  openPaths,
  activePath,
  runsByWorkspacePath,
  activeRuns,
  onSwitchWorkspace,
  onCloseWorkspace,
  onAddWorkspace,
  workspaceHasBackgroundRun,
  onSessionQuery,
  onOpenSettings,
  onOpenMarketplace,
  onOpenChat,
  onNewChat,
  onSelectRun,
  onSelectRunInWorkspace,
  onRenameRun,
  onRenameRunInWorkspace,
  onDeleteRun,
  onDeleteRunInWorkspace,
  onCloseDrawer,
  onToggleSidebar,
  collapsed = false,
  widthPx,
  variant = 'desktop'
}: SidebarProps) {
  const workspaceReady = Boolean(hasWorkspace)
  const needsWorkspaceLabel = 'Open a workspace first'
  const isDarwin = window.vyotiq?.platform === 'darwin'
  const isDrawer = variant === 'drawer'
  const isCollapsed = collapsed && !isDrawer
  const hotUi = useWorkspaceHotUi(activePath)
  const sessionQuery = activePath ? hotUi.sessionQuery : sessionQueryProp
  const [expandedByPath, setExpandedByPath] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!openPaths?.length) return
    setExpandedByPath((prev) => {
      const next: Record<string, boolean> = {}
      for (const path of openPaths) {
        next[path] = prev[path] ?? path === activePath
      }
      return next
    })
  }, [activePath, openPaths])

  const { filteredRuns, workspaceGroups } = useSidebarChats({
    openPaths: openPaths ?? [],
    activePath: activePath ?? null,
    sessionQuery,
    runsByWorkspacePath: runsByWorkspacePath ?? {},
    expandedByPath
  })

  const clearSearch = (): void => onSessionQuery('')

  const workspacesEnabled =
    openPaths &&
    onSwitchWorkspace &&
    onCloseWorkspace &&
    onAddWorkspace &&
    workspaceHasBackgroundRun &&
    activeRuns

  const workspaceProps = workspacesEnabled
    ? {
        openPaths,
        activePath: activePath ?? null,
        activeRuns,
        onSwitch: onSwitchWorkspace,
        onClose: onCloseWorkspace,
        onAdd: onAddWorkspace,
        workspaceHasBackgroundRun
      }
    : null

  const widthClass = isDrawer
    ? SIDEBAR_WIDTH
    : isCollapsed
      ? isDarwin
        ? SIDEBAR_WIDTH_COLLAPSED_DARWIN
        : SIDEBAR_WIDTH_COLLAPSED
      : undefined

  const expandedWidthPx =
    !isDrawer && !isCollapsed ? (widthPx ?? SIDEBAR_WIDTH_PX) : undefined

  const afterNav = (): void => {
    if (isDrawer) onCloseDrawer()
  }

  const openMarketplace = (): void => {
    clearSearch()
    onOpenMarketplace()
    afterNav()
  }

  return (
    <aside
      className={cn(
        SIDEBAR_CONTAINER,
        'flex h-full min-h-0 shrink-0 flex-col self-stretch overflow-hidden bg-bg',
        widthClass
      )}
      style={expandedWidthPx != null ? { width: expandedWidthPx } : undefined}
      aria-label="Sidebar"
      data-collapsed={isCollapsed || undefined}
    >
      {isCollapsed ? (
        <SidebarCollapsedHeader
          isDrawer={isDrawer}
          isCollapsed={isCollapsed}
          isDarwin={isDarwin}
          onToggleSidebar={onToggleSidebar}
        />
      ) : (
        <SidebarTopBar
          isDrawer={isDrawer}
          isDarwin={isDarwin}
          view={view}
          workspaceReady={workspaceReady}
          searchRef={searchRef}
          sessionQuery={sessionQuery}
          disabledTitle={needsWorkspaceLabel}
          onToggleSidebar={onToggleSidebar}
          onSessionQuery={onSessionQuery}
          onNewChat={() => {
            clearSearch()
            onNewChat()
            afterNav()
          }}
          onOpenSettings={() => {
            clearSearch()
            onOpenSettings()
            afterNav()
          }}
        />
      )}

      {isCollapsed ? (
        <div className="min-h-0 flex-1" />
      ) : (
        <div
          className="app-region-no-drag sidebar-scroll min-h-0 flex-1 overflow-x-hidden"
          data-sidebar-scroll
        >
          <ChatList
            workspaceReady={workspaceReady}
            sessionQuery={sessionQuery}
            filteredRunsCount={filteredRuns.length}
            workspaceGroups={workspaceGroups}
            onToggleWorkspace={(path) =>
              setExpandedByPath((prev) => ({ ...prev, [path]: !(prev[path] ?? false) }))
            }
            onSwitchWorkspace={(path) => {
              setExpandedByPath((prev) => ({ ...prev, [path]: true }))
              onSwitchWorkspace?.(path)
            }}
            onCloseWorkspace={(path) => onCloseWorkspace?.(path)}
            onAddWorkspace={() => onAddWorkspace?.()}
            activeRuns={activeRuns ?? []}
            workspaceHasBackgroundRun={(path) => workspaceHasBackgroundRun?.(path) ?? false}
            onDismissRunsError={(path) => onDismissRunsError?.(path)}
            onSelectRun={(path, runId) => {
              setExpandedByPath((prev) => ({ ...prev, [path]: true }))
              if (onSelectRunInWorkspace) onSelectRunInWorkspace(path, runId)
              else onSelectRun(runId)
              onOpenChat()
              afterNav()
            }}
            onRenameRun={(path, runId, goal) => {
              if (onRenameRunInWorkspace) onRenameRunInWorkspace(path, runId, goal)
              else onRenameRun(runId, goal)
            }}
            onDeleteRun={(path, runId) => {
              if (onDeleteRunInWorkspace) onDeleteRunInWorkspace(path, runId)
              else onDeleteRun(runId)
            }}
          />
        </div>
      )}

      <div
        className={cn(
          'app-region-no-drag shrink-0 border-t border-border/40',
          isCollapsed ? 'flex justify-center p-1.5' : 'p-2'
        )}
      >
        <NavItem
          label="Marketplace"
          icon="marketplace"
          variant={isCollapsed ? 'icon' : 'sidebar'}
          active={view === 'marketplace'}
          current={view === 'marketplace'}
          onClick={openMarketplace}
        />
      </div>
    </aside>
  )
}
