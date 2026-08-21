import { cn, Tooltip } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import {
  DOCK_CHROME_ICON_HOVER,
  DOCK_QUICK_LAUNCH_BTN,
  dockPanelTabButtonClass,
  dockPanelTabCloseClass,
  dockPanelTabShellClass,
  tabMiddleClickHandlers
} from './PanelChrome'

export type AgentSessionTab = {
  /** `null` = draft / new chat. */
  id: string | null
  title: string
  closable: boolean
  /** Run is executing — same pulsing dot as the sidebar's RunStatusDot. */
  running?: boolean
}

/**
 * Agent chat session tabs (+ new). Rendered in the immersive dock tab bar when
 * Agent is focused — mirrors {@link TerminalSessionBar} for PTY sessions.
 */
export function AgentSessionBar({
  sessions,
  activeId,
  onSelect,
  onClose,
  onCreate,
  className
}: {
  sessions: AgentSessionTab[]
  activeId: string | null
  onSelect: (id: string | null) => void
  onClose: (id: string) => void
  onCreate: () => void
  className?: string
}) {
  return (
    <div
      className={cn('inline-flex h-7 max-w-full min-w-0 items-center gap-0.5', className)}
      data-agent-session-bar
      role="tablist"
      aria-label="Agent sessions"
    >
      {sessions.length > 0 ? (
        <div className="flex min-w-0 max-w-[min(100%,24rem)] items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0">
          {sessions.map((s) => {
            const key = s.id ?? '__draft__'
            const selected = s.id === activeId
            return (
              <div
                key={key}
                className={dockPanelTabShellClass(selected, s.closable && s.id != null)}
                {...tabMiddleClickHandlers(() => {
                  if (s.closable && s.id) onClose(s.id)
                })}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={s.title}
                  tabIndex={selected ? 0 : -1}
                  className={dockPanelTabButtonClass(selected)}
                  onKeyDown={(e) => {
                    if (e.key === 'Delete' && s.closable && s.id) {
                      e.preventDefault()
                      onClose(s.id)
                    }
                  }}
                  onClick={() => onSelect(s.id)}
                >
                  <Icon
                    name="bot"
                    size={14}
                    className={cn('shrink-0', selected ? 'text-fg' : 'text-secondary')}
                  />
                  {s.running ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-fg motion-safe:animate-pulse"
                      title="Running"
                    >
                      <span className="sr-only">Running</span>
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate">{s.title}</span>
                </button>
                {s.closable && s.id ? (
                  <Tooltip content={`Close ${s.title}`}>
                    <button
                      type="button"
                      className={dockPanelTabCloseClass(selected)}
                      aria-label={`Close ${s.title}`}
                      aria-keyshortcuts="Delete"
                      tabIndex={selected ? 0 : -1}
                      onClick={(e) => {
                        e.stopPropagation()
                        onClose(s.id!)
                      }}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </Tooltip>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
      <Tooltip content="New chat">
        <button
          type="button"
          className={cn(DOCK_QUICK_LAUNCH_BTN, DOCK_CHROME_ICON_HOVER)}
          aria-label="New chat"
          onClick={onCreate}
        >
          <Icon name="plus" size={14} className="shrink-0" />
        </button>
      </Tooltip>
    </div>
  )
}
