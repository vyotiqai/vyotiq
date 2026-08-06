import { memo, useMemo, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { FileBadge } from './FileBadge'
import { TextShimmer } from './TextShimmer'
import type { ToolItem } from '../utils/transcriptRows'
import {
  ProminentChrome,
  ToolBodyView,
  getToolHeaderMeta,
  toolHasBody,
  type ToolBodyTiming
} from '../toolUi'

export const ToolCard = memo(function ToolCard({
  item,
  expanded,
  live = false,
  keepOpen = false,
  onToggle,
  onLoadFullContent,
  mcpServerNames
}: {
  item: ToolItem
  expanded?: boolean
  /** Active-turn run is live — stay open like ToolGroup until the turn settles. */
  live?: boolean
  keepOpen?: boolean
  onToggle?: (next: boolean) => void
  onLoadFullContent?: (toolCallId: string) => Promise<string | null>
  mcpServerNames?: ReadonlyMap<string, string>
}) {
  const { tool } = item
  const [localOverride, setLocalOverride] = useState<boolean | null>(null)
  const isOpen = expanded ?? localOverride ?? (live || keepOpen || tool.status === 'running')
  const failed = tool.status === 'fail'
  const running = tool.status === 'running'

  const headerMeta = useMemo(
    () =>
      getToolHeaderMeta(tool, {
        toolProgress: item.toolProgress
      }),
    [tool, item.toolProgress]
  )
  const hasBody = useMemo(
    () =>
      toolHasBody(tool, {
        toolProgress: item.toolProgress
      }),
    [tool, item.toolProgress]
  )
  /** Real wall-clock from transcript item — never invent timestamps. */
  const timing = useMemo((): ToolBodyTiming | undefined => {
    const fromAt = item.at ? Date.parse(item.at) : Number.NaN
    const startedAt =
      item.groupTiming?.startedAt ?? (Number.isFinite(fromAt) ? fromAt : undefined)
    if (startedAt == null || !Number.isFinite(startedAt)) return undefined
    return {
      startedAt,
      endedAt: item.groupTiming?.endedAt
    }
  }, [item.at, item.groupTiming?.startedAt, item.groupTiming?.endedAt])

  const toggle = (): void => {
    const next = !isOpen
    if (onToggle) onToggle(next)
    else setLocalOverride(next)
  }

  const disclosureLabel = hasBody
    ? `${isOpen ? 'Collapse' : 'Expand'} ${headerMeta.verb}${
        headerMeta.target ? `: ${headerMeta.target}` : ''
      }`
    : `${headerMeta.verb}${headerMeta.target ? ` ${headerMeta.target}` : ''}`

  const header = (
    <>
      {headerMeta.filePath ? (
        <FileBadge path={headerMeta.filePath} />
      ) : (
        <Icon
          name={headerMeta.icon ?? 'file'}
          size={14}
          className={cn('shrink-0', failed ? 'text-danger' : 'text-tertiary')}
        />
      )}
      {running ? (
        <TextShimmer className="shrink-0 font-medium text-fg">{headerMeta.verb}</TextShimmer>
      ) : (
        <span
          className={cn(
            'shrink-0 font-medium tool-status-morph',
            failed ? 'text-danger' : 'text-fg'
          )}
        >
          {headerMeta.verb}
        </span>
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-tertiary',
          // Command snippets stay mono; free-form edit paths use the default UI face.
          headerMeta.icon === 'terminal' && 'font-mono text-[11px]'
        )}
        title={headerMeta.target}
      >
        {headerMeta.target}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
        {failed && headerMeta.exitCode == null ? (
          <Icon name="warning" size={14} className="shrink-0 text-danger tool-status-morph" />
        ) : null}
        {headerMeta.exitCode != null ? (
          <span
            className={cn(
              'rounded-sm px-1 text-[10px]',
              headerMeta.exitCode === 0 ? 'text-success' : 'text-danger'
            )}
            title={`Exit code ${headerMeta.exitCode}`}
          >
            {headerMeta.exitCode === 0 ? 'exit 0' : `failed (${headerMeta.exitCode})`}
          </span>
        ) : null}
        {headerMeta.added != null && headerMeta.added > 0 ? (
          <span className="text-success">+{headerMeta.added}</span>
        ) : null}
        {headerMeta.removed != null && headerMeta.removed > 0 ? (
          <span className="text-danger">-{headerMeta.removed}</span>
        ) : null}
      </span>
    </>
  )

  return (
    <ProminentChrome
      header={header}
      clampWhenCollapsed
      ariaLabel={disclosureLabel}
      body={
        <ToolBodyView
          context={{
            tool,
            expanded: isOpen,
            toolProgress: item.toolProgress,
            onLoadFullContent,
            mcpServerNames,
            timing
          }}
        />
      }
      expanded={isOpen}
      hasBody={hasBody}
      running={running}
      onToggle={toggle}
    />
  )
})
