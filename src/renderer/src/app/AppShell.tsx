import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { Sidebar } from './sidebar'
import { BreakpointProvider, useIsDesktop } from '@renderer/lib/context/BreakpointProvider'
import { TitleBarAccessoryProvider } from '@renderer/lib/context/TitleBarAccessory'
import { useOverlayPanel } from '@renderer/lib/hooks/useOverlayPanel'
import { usePersistedBoolean } from '@renderer/lib/hooks/usePersistedBoolean'
import { usePersistedNumber } from '@renderer/lib/hooks/usePersistedNumber'
import { getWorkspaceHotUi } from '@renderer/lib/hooks/workspaceHotUiStore'
import type { WorkspaceSidebarRuns } from './sidebar/types'
import {
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX_PX,
  SIDEBAR_WIDTH_MIN_PX,
  SIDEBAR_WIDTH_PX,
  TITLE_BAR_HEIGHT_PX,
  clampSidebarWidthPx
} from '@renderer/lib/utils/layout'
import { PanelResizeHandle } from '@renderer/lib/ui'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { useAppShortcuts } from '@renderer/lib/shortcuts'
import { TitleBar } from './TitleBar'

function AppShellInner({
  view,
  workspacePath,
  openWorkspaces,
  runsByWorkspacePath,
  activeRuns,
  onDismissRunsError,
  sessionQuery,
  onSessionQuery,
  onOpenSettings,
  onOpenMarketplace,
  onOpenChat,
  onNewChat,
  onSelectRunInWorkspace,
  onRenameRunInWorkspace,
  onDeleteRunInWorkspace,
  onSwitchWorkspace,
  onCloseWorkspace,
  onAddWorkspace,
  workspaceHasBackgroundRun,
  running,
  onChatStop,
  children,
  loading
}: {
  view: 'chat' | 'settings' | 'marketplace'
  workspacePath: string | null
  openWorkspaces?: string[]
  runsByWorkspacePath?: Record<string, WorkspaceSidebarRuns>
  activeRuns?: { runId: string; workspacePath: string }[]
  onDismissRunsError?: (path?: string) => void
  sessionQuery: string
  onSessionQuery: (q: string) => void
  onOpenSettings: () => void
  onOpenMarketplace: () => void
  onOpenChat: () => void
  onNewChat: () => void
  onSelectRunInWorkspace?: (path: string, runId: string) => void
  onRenameRunInWorkspace?: (path: string, runId: string, goal: string) => void
  onDeleteRunInWorkspace?: (path: string, runId: string) => void
  onSwitchWorkspace?: (path: string) => void
  onCloseWorkspace?: (path: string) => void
  onAddWorkspace?: () => void
  workspaceHasBackgroundRun?: (path: string) => boolean
  /** When true, Escape may stop the active run (after other Esc handlers). */
  running?: boolean
  onChatStop?: () => void
  children: ReactNode
  loading?: boolean
}) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedBoolean(
    SIDEBAR_COLLAPSED_KEY,
    false
  )
  const [sidebarWidthPx, setSidebarWidthPx] = usePersistedNumber(
    SIDEBAR_WIDTH_KEY,
    SIDEBAR_WIDTH_PX,
    clampSidebarWidthPx
  )
  const searchRef = useRef<HTMLInputElement>(null)
  const pendingSearchFocusRef = useRef(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const drawerTriggerRef = useRef<HTMLElement | null>(null)
  const mainRef = useRef<HTMLElement>(null)
  const isDesktop = useIsDesktop()

  const closeDrawer = useCallback((): void => setDrawerOpen(false), [])

  const onToggleSidebar = useCallback((): void => {
    drawerTriggerRef.current = document.activeElement as HTMLElement | null
    if (isDesktop) {
      setSidebarCollapsed((v) => !v)
      setDrawerOpen(false)
    } else {
      setDrawerOpen((v) => !v)
    }
  }, [isDesktop, setSidebarCollapsed])

  const focusSearchInput = useCallback((): boolean => {
    const el = searchRef.current
    if (!el) return false
    el.focus()
    try {
      el.select()
    } catch {
      // jsdom / non-text inputs may reject select()
    }
    return document.activeElement === el
  }, [])

  const focusSearch = useCallback((): void => {
    if (isDesktop) {
      if (sidebarCollapsed) {
        pendingSearchFocusRef.current = true
        setSidebarCollapsed(false)
        return
      }
    } else if (!drawerOpen) {
      pendingSearchFocusRef.current = true
      drawerTriggerRef.current = document.activeElement as HTMLElement | null
      setDrawerOpen(true)
      return
    }
    if (!focusSearchInput()) {
      pendingSearchFocusRef.current = true
    }
  }, [
    isDesktop,
    sidebarCollapsed,
    drawerOpen,
    setSidebarCollapsed,
    focusSearchInput
  ])

  const hasWorkspace =
    Boolean(workspacePath) || (openWorkspaces?.length ?? 0) > 0

  useEffect(() => {
    if (isDesktop) setDrawerOpen(false)
  }, [isDesktop])

  useEffect(() => {
    const onResize = (): void => {
      setSidebarWidthPx((w) => clampSidebarWidthPx(w))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setSidebarWidthPx])

  useEffect(() => {
    if (!hasWorkspace) onSessionQuery('')
  }, [hasWorkspace, onSessionQuery])

  // Focus search after expand/drawer mount — single rAF is too early for the new tree.
  useEffect(() => {
    if (!pendingSearchFocusRef.current) return
    if (isDesktop ? sidebarCollapsed : !drawerOpen) return
    if (!hasWorkspace) {
      pendingSearchFocusRef.current = false
      return
    }

    let cancelled = false
    let attempts = 0
    const tryFocus = (): void => {
      if (cancelled) return
      if (focusSearchInput()) {
        pendingSearchFocusRef.current = false
        return
      }
      if (attempts++ < 16) {
        window.setTimeout(tryFocus, 0)
      } else {
        pendingSearchFocusRef.current = false
      }
    }
    window.setTimeout(tryFocus, 0)
    return () => {
      cancelled = true
    }
  }, [sidebarCollapsed, drawerOpen, isDesktop, hasWorkspace, focusSearchInput])

  useEffect(() => {
    if (drawerOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[aria-expanded="true"][aria-haspopup]')) return
      if (!getWorkspaceHotUi(workspacePath).sessionQuery.trim()) return
      e.preventDefault()
      e.stopPropagation()
      onSessionQuery('')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drawerOpen, workspacePath, onSessionQuery])

  useOverlayPanel({
    open: drawerOpen,
    onClose: closeDrawer,
    panelRef: drawerRef,
    inertTargetRef: mainRef,
    restoreFocusRef: drawerTriggerRef
  })

  const clearSearchFocus = useCallback((): void => {
    onSessionQuery('')
    searchRef.current?.blur()
  }, [onSessionQuery])

  const isSearchFocused = useCallback(
    (): boolean => document.activeElement === searchRef.current,
    []
  )

  const hasSessionQuery = useCallback(
    (): boolean => Boolean(getWorkspaceHotUi(workspacePath).sessionQuery.trim()),
    [workspacePath]
  )

  useAppShortcuts({
    onToggleSidebar,
    onFocusSearch: focusSearch,
    onClearSearchFocus: clearSearchFocus,
    isSearchFocused,
    onNewChat,
    onOpenSettings,
    chatViewActive: view === 'chat',
    running,
    onStop: onChatStop,
    drawerOpen,
    hasSessionQuery
  })

  const sidebarProps = {
    view,
    onDismissRunsError,
    sessionQuery,
    searchRef,
    hasWorkspace,
    openPaths: openWorkspaces,
    activePath: workspacePath,
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
    onSelectRunInWorkspace,
    onRenameRunInWorkspace,
    onDeleteRunInWorkspace,
    onCloseDrawer: closeDrawer,
    onToggleSidebar
  }

  return (
    <div className="flex h-full overflow-hidden bg-bg text-fg">
      {/* Mount only on desktop so searchRef is never bound to a hidden sibling. */}
      {isDesktop ? (
        <>
          <div className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden self-stretch">
            <ErrorBoundary
              title="Sidebar couldn't render"
              resetKey={(openWorkspaces ?? []).join('|')}
            >
              <Sidebar
                {...sidebarProps}
                collapsed={sidebarCollapsed}
                widthPx={sidebarWidthPx}
              />
            </ErrorBoundary>
          </div>
          {!sidebarCollapsed ? (
            <PanelResizeHandle
              label="Resize sidebar"
              value={sidebarWidthPx}
              min={SIDEBAR_WIDTH_MIN_PX}
              max={SIDEBAR_WIDTH_MAX_PX}
              edge="end"
              onChange={setSidebarWidthPx}
            />
          ) : null}
        </>
      ) : null}

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col self-stretch">
        <ErrorBoundary title="Title bar couldn't render">
          <TitleBar drawerOpen={drawerOpen} onToggleSidebar={onToggleSidebar} />
        </ErrorBoundary>

        {drawerOpen && !isDesktop ? (
          <div
            ref={drawerRef}
            id="app-nav-drawer"
            className="absolute inset-x-0 bottom-0 z-drawer flex outline-none"
            style={{ top: TITLE_BAR_HEIGHT_PX }}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            tabIndex={-1}
          >
            <div
              className="absolute inset-0 bg-overlay animate-fade-in"
              data-overlay-scrim
              aria-hidden
              onClick={closeDrawer}
            />
            <div className="relative z-sticky h-full min-h-0 animate-slide-in-left shadow-[var(--vy-shadow-menu)]">
              <ErrorBoundary
                title="Sidebar couldn't render"
                resetKey={(openWorkspaces ?? []).join('|')}
              >
                <Sidebar {...sidebarProps} variant="drawer" />
              </ErrorBoundary>
            </div>
          </div>
        ) : null}

        <main
          ref={mainRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg outline-none"
          tabIndex={-1}
          aria-busy={loading ? true : undefined}
        >
          {children}
        </main>
      </div>
    </div>
  )
}

export function AppShell(
  props: Parameters<typeof AppShellInner>[0]
): ReactElement {
  return (
    <BreakpointProvider>
      <TitleBarAccessoryProvider>
        <AppShellInner {...props} />
      </TitleBarAccessoryProvider>
    </BreakpointProvider>
  )
}
