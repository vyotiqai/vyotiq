import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import type { TodoItem, TodoStatus } from '../toolUi/parsers/todo'

const STATUS_ICON: Record<
  TodoStatus,
  { name: 'check' | 'loader' | 'close' | 'circle'; className: string }
> = {
  pending: { name: 'circle', className: 'text-muted' },
  in_progress: { name: 'loader', className: 'text-secondary motion-safe:animate-spin' },
  completed: { name: 'check', className: 'text-success' },
  cancelled: { name: 'close', className: 'text-muted' }
}

/** Status glyph shared by the checklist, ceiling band, and floating task rail. */
export function TodoStatusIcon({
  status,
  size,
  className
}: {
  status: TodoStatus
  size: number
  className?: string
}) {
  const icon = STATUS_ICON[status]
  return (
    <Icon
      name={icon.name}
      size={size}
      className={cn('shrink-0 tool-status-morph', icon.className, className)}
    />
  )
}

/** Shared checklist for the Plan Tasks section, ceiling band, and failed inline todo tools. */
export function TodoChecklist({
  items,
  className,
  density = 'default'
}: {
  items: readonly TodoItem[]
  className?: string
  density?: 'default' | 'compact'
}) {
  const compact = density === 'compact'
  return (
    <ul className={cn('m-0 list-none', className)}>
      {items.map((item, index) => (
        <li
          key={item.id ?? index}
          className={cn(
            'flex items-start gap-1.5',
            compact
              ? 'min-w-0 py-0.5 text-2xs leading-snug'
              : 'min-w-0 gap-2 py-0.5 text-caption leading-relaxed'
          )}
        >
          <TodoStatusIcon
            status={item.status}
            size={compact ? 12 : 14}
            className={compact ? 'mt-px' : 'mt-0.5'}
          />
          <span
            title={compact ? item.content : undefined}
            className={cn(
              'min-w-0 text-secondary',
              compact
                ? 'line-clamp-3 [overflow-wrap:anywhere]'
                : 'whitespace-pre-wrap [overflow-wrap:anywhere]',
              item.status === 'in_progress' && 'font-medium text-fg',
              item.status === 'completed' && 'text-muted line-through',
              item.status === 'cancelled' && 'text-muted'
            )}
          >
            {item.content}
          </span>
        </li>
      ))}
    </ul>
  )
}
