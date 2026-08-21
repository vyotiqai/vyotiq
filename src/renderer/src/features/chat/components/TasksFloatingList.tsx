import { Icon } from '@renderer/lib/icons'
import { Tooltip, cn } from '@renderer/lib/ui'
import { useRunTodos } from '../hooks/useRunTodos'
import { pickCurrentTask } from '../toolUi/parsers/todo'

/**
 * Compact progress control that sits immediately left of the Plan rail icon.
 * Clicking opens the Plan dock (full task list lives there).
 */
export function TasksRailChip({
  workspacePath,
  runId,
  running = false,
  onOpenPlan,
  className
}: {
  workspacePath: string | null
  runId: string | null
  running?: boolean
  onOpenPlan: () => void
  className?: string
}) {
  const { data } = useRunTodos({
    workspacePath,
    runId,
    running,
    active: Boolean(workspacePath && runId)
  })

  const items = data?.items ?? []
  if (items.length === 0) return null

  const current = pickCurrentTask(items)
  const count = `${data!.done}/${data!.total}`
  const liveLabel = current ? `${count} · ${current.content}` : count

  return (
    <Tooltip content={liveLabel}>
      <button
        type="button"
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-md bg-bg/90 px-1.5 text-muted vy-transition hover:bg-surface hover:text-fg',
          className
        )}
        aria-label={`Tasks ${data!.done} of ${data!.total}. Show plan panel`}
        data-tasks-floating
        data-tasks-floating-chip
        onClick={onOpenPlan}
      >
        <span className="sr-only" role="status" aria-live="polite">
          {liveLabel}
        </span>
        <Icon name="listTodo" size={16} />
        <span
          className="tabular-nums text-2xs"
          data-tasks-floating-count
        >
          {count}
        </span>
      </button>
    </Tooltip>
  )
}
