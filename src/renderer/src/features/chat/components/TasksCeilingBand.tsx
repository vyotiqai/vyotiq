import { useEffect, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { useRunSession } from '../RunSessionContext'
import { useRunTodos } from '../hooks/useRunTodos'
import { pickCurrentTask } from '../toolUi/parsers/todo'
import { TodoChecklist, TodoStatusIcon } from './TodoChecklist'

/**
 * One-liner task strip directly under the task-owning user prompt. Expands in
 * place; same ~840px column, no blank card chrome.
 */
export function TasksCeilingBand({
  workspacePath: workspacePathProp,
  runId: runIdProp,
  running = false,
  className
}: {
  workspacePath?: string | null
  runId?: string | null
  running?: boolean
  className?: string
}) {
  const session = useRunSession()
  const workspacePath =
    workspacePathProp !== undefined ? workspacePathProp : session.workspacePath
  const runId = runIdProp !== undefined ? runIdProp : session.runId
  const { data } = useRunTodos({
    workspacePath,
    runId,
    running,
    active: true
  })
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setExpanded(false)
  }, [runId])

  const items = data?.items ?? []
  if (items.length === 0) return null

  const current = pickCurrentTask(items)
  if (!current) return null

  const label = `${data!.done}/${data!.total}`

  return (
    <div className={cn('w-full min-w-0', className)} data-tasks-ceiling>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse tasks' : 'Expand tasks'}
        onClick={() => setExpanded((v) => !v)}
      >
        <TodoStatusIcon status={current.status} size={14} />
        <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg">
          {current.content}
        </span>
        <span className="shrink-0 tabular-nums text-caption text-muted">{label}</span>
        <Icon
          name="chevron"
          size={14}
          className={cn(
            'shrink-0 text-muted transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </button>
      {expanded ? (
        <TodoChecklist items={items} className="px-2.5 pb-1.5" />
      ) : null}
    </div>
  )
}
