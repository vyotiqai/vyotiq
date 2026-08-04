import { useMemo } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { TOOL_BODY_INNER } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseTodoData } from '../parsers/todo'
import type { TodoStatus } from '../parsers/todo'

const STATUS_ICON: Record<
  TodoStatus,
  { name: 'check' | 'loader' | 'close' | 'circle'; className: string }
> = {
  pending: { name: 'circle', className: 'text-muted' },
  in_progress: { name: 'loader', className: 'text-secondary motion-safe:animate-spin' },
  completed: { name: 'check', className: 'text-success' },
  cancelled: { name: 'close', className: 'text-muted' }
}

export function TodoBody({ tool }: ToolBodyProps) {
  const data = useMemo(() => parseTodoData(tool), [tool])

  return (
    <ul className={cn(TOOL_BODY_INNER, 'm-0 list-none')}>
      {data.items.map((item, index) => {
        const icon = STATUS_ICON[item.status]
        return (
          <li key={index} className="flex items-start gap-2 py-0.5 text-[11px] leading-relaxed">
            <Icon
              name={icon.name}
              size={14}
              className={cn('mt-0.5 shrink-0 tool-status-morph', icon.className)}
            />
            <span
              className={cn(
                'min-w-0 whitespace-pre-wrap text-secondary [overflow-wrap:anywhere]',
                item.status === 'completed' && 'text-muted line-through',
                item.status === 'cancelled' && 'text-muted'
              )}
            >
              {item.content}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
