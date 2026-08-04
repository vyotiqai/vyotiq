import { useMemo } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseDeleteData } from '../parsers/delete'

export function DeleteBody({ tool }: ToolBodyProps) {
  const data = useMemo(() => parseDeleteData(tool), [tool])

  return (
    <div className={cn(TOOL_BODY_PAD, 'flex items-start gap-2 text-[11px]')}>
      <Icon name="trash" size={16} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0">
        <p className="m-0 text-fg/80">{data.message}</p>
        {data.recursive ? (
          <p className="m-0 mt-1 text-tertiary">Recursive delete</p>
        ) : null}
      </div>
    </div>
  )
}
