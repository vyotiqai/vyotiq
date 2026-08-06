import type { RefObject } from 'react'
import { IconButton, cn } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { TITLE_BAR_HEIGHT } from '@renderer/lib/utils/layout'
import { MACOS_TITLEBAR_INSET_PX, MACOS_TRAFFIC_LIGHT_Y } from '@shared/windowChrome'
import type { SidebarView } from './types'
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

  return (
    <header
      className={cn(
        'app-region-drag flex shrink-0 items-center gap-0.5 px-1',
        TITLE_BAR_HEIGHT
      )}
      style={headerStyle}
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

      <div className="app-region-no-drag min-w-0 flex-1">
        <SidebarSearchChrome
          searchRef={searchRef}
          sessionQuery={sessionQuery}
          workspaceReady={workspaceReady}
          disabledTitle={disabledTitle}
          onSessionQuery={onSessionQuery}
          onNewChat={onNewChat}
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
        'app-region-drag flex shrink-0 items-center',
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
          aria-expanded={isDrawer ? true : !isCollapsed}
          aria-controls={isDrawer ? 'app-nav-drawer' : undefined}
          onClick={onToggleSidebar}
        />
      </div>
    </header>
  )
}
