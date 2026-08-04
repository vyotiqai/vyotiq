import { IconButton, cn } from '@renderer/lib/ui'
import { CHAT_SIDE_RAIL_WIDTH, type ChatRightPanelId } from '@renderer/lib/utils/layout'
import { DOCK_PANELS } from '@renderer/lib/utils/dockPanels'

/**
 * Floating right rail for toggling chat secondary panels.
 * Overlays the pane edge so the transcript can scroll edge-to-edge (scrollbar
 * sits under the rail rather than stopping short of it).
 */
export function ChatSideRail({
  activePanel,
  onSelectPanel,
  onExpandPanels,
  className
}: {
  activePanel: ChatRightPanelId | null
  onSelectPanel: (panel: ChatRightPanelId) => void
  /** Re-enter immersive when panels remain after collapsing from Agent. */
  onExpandPanels?: () => void
  className?: string
}) {
  return (
    <aside
      className={cn(
        'pointer-events-none absolute inset-y-0 right-0 z-dropdown flex h-full flex-col items-center justify-start bg-gradient-to-l from-bg via-bg/80 to-transparent pt-2',
        CHAT_SIDE_RAIL_WIDTH,
        className
      )}
      data-chat-side-rail
      aria-label="Panels"
    >
      <div className="pointer-events-auto flex w-full flex-col items-center gap-1">
        {DOCK_PANELS.map((item) => {
          const open = activePanel === item.id
          return (
            <IconButton
              key={item.id}
              icon={item.icon}
              label={open ? item.hideLabel : item.showLabel}
              variant="ghost"
              size="sm"
              aria-pressed={open}
              className={cn(
                'text-muted hover:text-fg',
                open && 'bg-bg text-fg ring-1 ring-border/60'
              )}
              onClick={() => onSelectPanel(item.id)}
            />
          )
        })}
        {onExpandPanels ? (
          <IconButton
            icon="maximize"
            label="Expand panel"
            variant="ghost"
            size="sm"
            className="mt-1 text-muted hover:text-fg"
            onClick={onExpandPanels}
          />
        ) : null}
      </div>
    </aside>
  )
}
