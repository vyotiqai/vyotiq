import { cn, IconButton, Tooltip } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import type { PtySessionInfo } from '@shared/ipc'

/**
 * PTY session tabs (+ / split). Rendered in the dock tab bar when the terminal
 * panel is active so we do not stack a second tab row inside the panel body.
 */
export function TerminalSessionBar({
  sessions,
  activeId,
  splitId,
  onSelect,
  onKill,
  onCreate,
  onToggleSplit,
  className
}: {
  sessions: PtySessionInfo[]
  activeId: string | null
  splitId: string | null
  onSelect: (id: string) => void
  onKill: (id: string) => void
  onCreate: () => void
  onToggleSplit: () => void
  className?: string
}) {
  const activeSession = sessions.find((s) => s.id === activeId) ?? null

  return (
    <div
      className={cn('flex min-w-0 items-center gap-0.5', className)}
      data-terminal-session-bar
      role="tablist"
      aria-label="Terminal sessions"
    >
      {sessions.map((s) => (
        <div
          key={s.id}
          className={cn(
            'group inline-flex h-7 max-w-[9rem] shrink-0 items-center gap-0.5 rounded-md pl-2 pr-1',
            s.id === activeId ? 'bg-surface text-fg' : 'text-muted hover:bg-surface/60'
          )}
        >
          <button
            type="button"
            role="tab"
            aria-selected={s.id === activeId}
            className="inline-flex min-w-0 items-center gap-1 truncate text-xs leading-tight"
            onClick={() => onSelect(s.id)}
          >
            <Icon name="terminal" size={12} className="shrink-0 opacity-70" />
            <span className="truncate">
              {s.title}
              {!s.running ? ' (exited)' : ''}
            </span>
          </button>
          <Tooltip content={`Close ${s.title}`}>
            <button
              type="button"
              className="inline-grid size-5 shrink-0 place-items-center rounded-md opacity-0 vy-transition hover:bg-surface-2 group-hover:opacity-100 group-focus-within:opacity-100"
              aria-label={`Close ${s.title}`}
              onClick={() => onKill(s.id)}
            >
              <Icon name="close" size={10} />
            </button>
          </Tooltip>
        </div>
      ))}
      <IconButton
        icon="plus"
        label="New terminal"
        variant="bare"
        size="sm"
        className="text-muted"
        onClick={onCreate}
      />
      {activeSession ? (
        <IconButton
          icon="columns"
          label={splitId ? 'Unsplit terminals' : 'Split terminal'}
          variant="bare"
          size="sm"
          className={cn('text-muted', splitId && 'text-fg')}
          onClick={onToggleSplit}
        />
      ) : null}
    </div>
  )
}
