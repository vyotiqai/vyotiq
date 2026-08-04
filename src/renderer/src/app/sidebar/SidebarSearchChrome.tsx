import type { RefObject } from 'react'
import { Icon } from '@renderer/lib/icons'
import { IconButton, Tooltip, cn } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import type { SidebarView } from './types'

export function SidebarSearchChrome({
  searchRef,
  sessionQuery,
  workspaceReady,
  disabledTitle,
  view,
  onSessionQuery,
  onNewChat,
  onOpenSettings
}: {
  searchRef: RefObject<HTMLInputElement | null>
  sessionQuery: string
  workspaceReady: boolean
  disabledTitle?: string
  view: SidebarView
  onSessionQuery: (q: string) => void
  onNewChat: () => void
  onOpenSettings: () => void
}) {
  const showShortcut = workspaceReady && !sessionQuery

  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border/40 bg-surface/50 px-1.5',
        'h-7 vy-transition focus-within:border-border focus-within:bg-surface focus-within:vy-focus-ring'
      )}
    >
      <Icon name="search" size={16} className="shrink-0 text-muted" aria-hidden />

      <input
        ref={searchRef}
        type="text"
        disabled={!workspaceReady}
        className="min-w-0 flex-1 border-none bg-transparent py-0.5 text-[13px] text-fg outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]"
        placeholder={workspaceReady ? 'Search' : 'Open workspace'}
        value={sessionQuery}
        aria-label="Search chats"
        aria-keyshortcuts="Meta+K Control+K"
        onChange={(e) => onSessionQuery(e.target.value)}
      />

      {sessionQuery ? (
        <Tooltip content="Clear search">
          <button
            type="button"
            className="inline-grid size-5 shrink-0 place-items-center rounded text-muted vy-transition hover:text-fg"
            aria-label="Clear search"
            onClick={() => onSessionQuery('')}
          >
            <Icon name="close" size={14} />
          </button>
        </Tooltip>
      ) : showShortcut ? (
        <kbd className="hidden shrink-0 rounded border border-border/50 px-0.5 py-px text-[9px] font-medium text-muted @min-[13rem]/sidebar:inline">
          {shortcutLabel('search')}
        </kbd>
      ) : null}

      <div
        className="flex shrink-0 items-center gap-px border-l border-border/40 pl-1"
        role="toolbar"
        aria-label="Sidebar actions"
      >
        <IconButton
          icon="plus"
          label="New chat"
          size="xs"
          variant="bare"
          disabled={!workspaceReady}
          title={
            !workspaceReady
              ? disabledTitle
              : `New chat (${shortcutLabel('newChat')})`
          }
          onClick={onNewChat}
        />
        <IconButton
          icon="gear"
          label="Settings"
          size="xs"
          variant="bare"
          title={`Settings (${shortcutLabel('settings')})`}
          aria-current={view === 'settings' ? 'page' : undefined}
          onClick={onOpenSettings}
        />
      </div>
    </div>
  )
}
