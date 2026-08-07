import type { RefObject } from 'react'
import { IconButton, cn } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import {
  SIDEBAR_SEARCH_ROW,
  SIDEBAR_TOOLBAR_ROW,
  TITLE_BAR_HEIGHT
} from '@renderer/lib/utils/layout'
import { MACOS_TITLEBAR_INSET_PX, MACOS_TRAFFIC_LIGHT_Y } from '@shared/windowChrome'
import { SidebarSearchChrome } from './SidebarSearchChrome'

export function SidebarTopBar({
  isDrawer,
  isDarwin,
  workspaceReady,
  searchRef,
  sessionQuery,
  disabledTitle,
  onToggleSidebar,
  onSessionQuery,
  onNewChat
}: {
  isDrawer: boolean
  isDarwin: boolean
  workspaceReady: boolean
  searchRef: RefObject<HTMLInputElement | null>
  sessionQuery: string
  disabledTitle?: string
  onToggleSidebar: () => void
  onSessionQuery: (q: string) => void
  onNewChat: () => void
}) {
  const toggleLabel = isDrawer ? 'Close menu' : 'Collapse sidebar'
  const toggleTitle = isDrawer
    ? toggleLabel
    : `${toggleLabel} (${shortcutLabel('sidebar')})`
  const headerStyle = isDarwin ? { paddingLeft: MACOS_TITLEBAR_INSET_PX } : undefined
  const alignWithTitleBar = !isDrawer

  return (
    <header
      className="app-region-drag shrink-0 flex flex-col border-b border-border/30"
      style={headerStyle}
    >
      <div
        className={cn(
          alignWithTitleBar ? SIDEBAR_TOOLBAR_ROW : 'flex items-center gap-0.5 px-2 py-1.5'
        )}
      >
        <div className="app-region-no-drag shrink-0">
          <IconButton
            icon={isDrawer ? 'close' : 'sidebar'}
            label={toggleLabel}
            title={toggleTitle}
            size="sm"
            variant="bare"
            aria-expanded={isDrawer ? true : undefined}
            aria-controls={isDrawer ? 'app-nav-drawer' : undefined}
            onClick={onToggleSidebar}
          />
        </div>

        <div className="app-region-no-drag shrink-0">
          <IconButton
            icon="plus"
            label="New chat"
            size="sm"
            variant="bare"
            disabled={!workspaceReady}
            title={
              !workspaceReady ? disabledTitle : `New chat (${shortcutLabel('newChat')})`
            }
            onClick={onNewChat}
          />
        </div>
      </div>

      <div className={SIDEBAR_SEARCH_ROW}>
        <SidebarSearchChrome
          searchRef={searchRef}
          sessionQuery={sessionQuery}
          workspaceReady={workspaceReady}
          onSessionQuery={onSessionQuery}
        />
      </div>
    </header>
  )
}

export function SidebarCollapsedHeader({
  isDrawer,
  isCollapsed,
  isDarwin,
  onToggleSidebar
}: {
  isDrawer: boolean
  isCollapsed: boolean
  isDarwin: boolean
  onToggleSidebar: () => void
}) {
  const toggleLabel = isDrawer
    ? 'Close menu'
    : isCollapsed
      ? 'Expand sidebar'
      : 'Collapse sidebar'
  const toggleTitle = isDrawer
    ? toggleLabel
    : `${toggleLabel} (${shortcutLabel('sidebar')})`

  const headerStyle = isDarwin
    ? isCollapsed
      ? { paddingTop: MACOS_TRAFFIC_LIGHT_Y + 10 }
      : { paddingLeft: MACOS_TITLEBAR_INSET_PX }
    : undefined

  return (
    <header
      className={cn(
        'app-region-drag flex shrink-0 items-center border-b border-border/30',
        isCollapsed && isDarwin ? 'min-h-9' : TITLE_BAR_HEIGHT,
        'justify-center px-1'
      )}
      style={headerStyle}
    >
      <div className="app-region-no-drag">
        <IconButton
          icon={isDrawer ? 'close' : 'sidebar'}
          label={toggleLabel}
          title={toggleTitle}
          size="md"
          variant="bare"
          className="rounded-lg"
          aria-expanded={isDrawer ? true : !isCollapsed}
          aria-controls={isDrawer ? 'app-nav-drawer' : undefined}
          onClick={onToggleSidebar}
        />
      </div>
    </header>
  )
}
