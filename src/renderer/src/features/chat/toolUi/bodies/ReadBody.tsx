import { useMemo } from 'react'
import { cn } from '@renderer/lib/ui'
import { READ_BODY_PREVIEW_LINES, TOOL_BODY_CLAMP_PX, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseReadData } from '../parsers/read'
import { CodeBlock, DirListing, TruncatedBanner } from '../primitives'

const DIR_SECTION_LABEL =
  'text-[10px] font-medium uppercase tracking-[0.07em] text-tertiary'

export function ReadBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseReadData(tool), [tool])
  const totalLines = data.lines.length
  const previewLines = data.isDirectory
    ? data.lines
    : data.lines.slice(0, READ_BODY_PREVIEW_LINES)
  const clamped = !data.isDirectory && totalLines > READ_BODY_PREVIEW_LINES

  return (
    <div>
      {data.isDirectory ? (
        <div className={`${TOOL_BODY_PAD} pb-1`}>
          <span className={DIR_SECTION_LABEL}>Directory</span>
        </div>
      ) : totalLines > 0 ? (
        <div className={`${TOOL_BODY_PAD} pb-1`}>
          <span className="text-[10px] tabular-nums text-tertiary">
            {totalLines} {totalLines === 1 ? 'line' : 'lines'}
            {clamped ? ` · showing ${previewLines.length}` : ''}
            {data.lineRange ? ` · ${data.lineRange}` : ''}
          </span>
        </div>
      ) : null}
      {tool.contentTruncated && data.isDirectory ? (
        <TruncatedBanner loading={loading} failed={loadFailed} />
      ) : null}
      {data.isDirectory ? (
        <DirListing
          entries={data.lines.map((line) => {
            const dir = line.match(/^\[dir\]\s+(.+)$/)
            if (dir) return { kind: 'dir' as const, name: dir[1]!, size: '' }
            const file = line.match(/^\[file\]\s+(.+)$/)
            return { kind: 'file' as const, name: file?.[1] ?? line, size: '' }
          })}
        />
      ) : (
        <div
          className={cn('overflow-hidden', clamped && 'mask-fade-bottom')}
          style={{ maxHeight: TOOL_BODY_CLAMP_PX }}
          data-testid="read-body-clamp"
        >
          <CodeBlock lines={previewLines} />
        </div>
      )}
    </div>
  )
}
