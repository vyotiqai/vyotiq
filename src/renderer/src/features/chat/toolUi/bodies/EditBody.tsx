import { useMemo } from 'react'
import { cn } from '@renderer/lib/ui'
import { TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { DiffPreview } from '../../components/DiffPreview'
import type { ToolBodyProps } from '../types'
import { parseDiffPreview, parseEditCardData } from '../parsers/edit'
import { TruncatedBanner } from '../primitives'

export function EditBody({ tool, expanded, loading, loadFailed }: ToolBodyProps) {
  const editData = useMemo(() => parseEditCardData(tool), [tool])
  const diffLines = useMemo(() => parseDiffPreview(tool), [tool])
  const status = (tool.content ?? '').trim()

  return (
    <div aria-busy={loading || undefined}>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      {diffLines.length > 0 ? (
        <DiffPreview lines={diffLines} path={editData.path} expanded={expanded} />
      ) : status ? (
        <p
          className={cn(
            TOOL_BODY_PAD,
            'm-0 text-[11px] text-fg/80 [overflow-wrap:anywhere]'
          )}
        >
          {status}
        </p>
      ) : null}
    </div>
  )
}

export function MultiEditBody(props: ToolBodyProps) {
  return <EditBody {...props} />
}
