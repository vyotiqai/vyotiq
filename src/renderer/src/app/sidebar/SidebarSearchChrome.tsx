import type { RefObject } from 'react'
import { IconButton, SearchInput, cn } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'

export function SidebarSearchChrome({
  searchRef,
  sessionQuery,
  workspaceReady,
  disabledTitle,
  onSessionQuery,
  onNewChat
}: {
  searchRef: RefObject<HTMLInputElement | null>
  sessionQuery: string
  workspaceReady: boolean
  disabledTitle?: string
  onSessionQuery: (q: string) => void
  onNewChat: () => void
}) {
  const showShortcut = workspaceReady && !sessionQuery

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <SearchInput
        ref={searchRef}
        tone="quiet"
        disabled={!workspaceReady}
        className={cn(
          'min-h-8 min-w-0 flex-1 gap-1.5 border border-border/30 px-2 focus-within:border-border/60',
          'bg-surface/50 focus-within:bg-surface'
        )}
        inputClassName="min-h-8 py-1 text-[13px]"
        placeholder={workspaceReady ? 'Search' : 'Open workspace'}
        value={sessionQuery}
        aria-label="Search chats"
        aria-keyshortcuts="Meta+K Control+K"
        onChange={(e) => onSessionQuery(e.target.value)}
        onClear={sessionQuery ? () => onSessionQuery('') : undefined}
        trailing={
          showShortcut ? (
            <kbd className="hidden shrink-0 rounded border border-border/50 px-0.5 py-px text-[9px] font-medium text-muted @min-[13rem]/sidebar:inline">
              {shortcutLabel('search')}
            </kbd>
          ) : undefined
        }
      />

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
  )
}
