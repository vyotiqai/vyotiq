import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { ACTIVITY_ROW, DISCLOSURE_ROW, TOOL_GROUP_LIST_VIEWPORT } from '@renderer/lib/utils/layout'
import type { ToolItem } from '../utils/transcriptRows'
import { mapToolGroupProps, type ToolGroupNestedTool } from '../utils/toolGroupAdapter'
import { TextShimmer } from './TextShimmer'
import { ToolRowOutput } from './ToolRow'
import {
  CompactRow,
  ExpandPanel,
  isInterruptedToolContent,
  toolCategory,
  toolDefaultExpanded,
  toolHasBody,
  toolLabel
} from '../toolUi'

const LIST_PIN_PX = 24

/** Earliest start to latest end across every batch in the group. */
function spanGroupTiming(tools: ToolItem[]): ToolItem['groupTiming'] {
  let startedAt: number | undefined
  let endedAt: number | undefined
  let open = false

  for (const item of tools) {
    const timing = item.groupTiming
    if (timing?.startedAt != null) {
      startedAt = startedAt == null ? timing.startedAt : Math.min(startedAt, timing.startedAt)
      if (timing.endedAt == null) open = true
      else endedAt = endedAt == null ? timing.endedAt : Math.max(endedAt, timing.endedAt)
    }
  }

  if (startedAt == null) return undefined
  return open || endedAt == null ? { startedAt } : { startedAt, endedAt }
}

function NestedToolRow({
  item,
  nested,
  staggerIndex,
  isToolExpanded,
  onToolToggle,
  onLoadFullContent,
  mcpServerNames
}: {
  item: ToolItem
  nested: ToolGroupNestedTool
  staggerIndex: number
  isToolExpanded: boolean
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onLoadFullContent?: (toolCallId: string) => Promise<string | null>
  mcpServerNames?: ReadonlyMap<string, string>
}) {
  const hasBody = toolHasBody(item.tool, {
    toolProgress: item.toolProgress
  })
  const rowInterrupted = isInterruptedToolContent(item.tool.content)
  return (
    <div
      className="tool-stagger-enter flex min-w-0 flex-col"
      style={{ '--stagger-index': staggerIndex } as CSSProperties}
    >
      <CompactRow
        title={nested.title}
        subtitle={nested.subtitle}
        status={nested.status}
        expanded={isToolExpanded}
        hasBody={hasBody}
        interrupted={rowInterrupted}
        onToggle={() => onToolToggle?.(item.id, !isToolExpanded)}
      />
      <ExpandPanel open={hasBody && isToolExpanded}>
        <div className="tool-body-enter">
          <ToolRowOutput
            tool={item.tool}
            toolProgress={item.toolProgress}
            onLoadFullContent={onLoadFullContent}
            mcpServerNames={mcpServerNames}
            inGroup
            indent={false}
          />
        </div>
      </ExpandPanel>
    </div>
  )
}

export const ToolGroup = memo(function ToolGroup({
  tools,
  groupTiming,
  groupExpanded,
  /** True for the active turn while the chat run is live — keep this group open between batches. */
  live = false,
  keepOpen = false,
  onGroupToggle,
  onToolToggle,
  onLoadFullContent,
  mcpServerNames
}: {
  tools: ToolItem[]
  groupTiming?: ToolItem['groupTiming']
  groupExpanded?: boolean
  live?: boolean
  keepOpen?: boolean
  onGroupToggle?: (expanded: boolean) => void
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onLoadFullContent?: (toolCallId: string) => Promise<string | null>
  mcpServerNames?: ReadonlyMap<string, string>
}) {
  const uiTools = useMemo(() => tools.map((item) => item.tool), [tools])
  const resolvedGroupTiming = useMemo(
    () => groupTiming ?? spanGroupTiming(tools),
    [groupTiming, tools]
  )
  const props = useMemo(
    () => mapToolGroupProps(uiTools, { groupTiming: resolvedGroupTiming }),
    [uiTools, resolvedGroupTiming]
  )

  const { state, nestedTools, summary, singleTool } = props
  const isPending = state === 'pending'
  const isInterrupted = state === 'interrupted'

  const nestedById = useMemo(() => {
    const map = new Map<string, ToolGroupNestedTool>()
    for (const tool of nestedTools) map.set(tool.id, tool)
    return map
  }, [nestedTools])

  const [localOverride, setLocalOverride] = useState<boolean | null>(null)
  // Honor explicit persisted collapse even while pending; otherwise auto-open while live.
  const expanded =
    groupExpanded !== undefined
      ? groupExpanded
      : isPending
        ? true
        : (localOverride ?? (live || keepOpen))
  const toggle = (): void => {
    const next = !expanded
    if (onGroupToggle) onGroupToggle(next)
    else setLocalOverride(next)
  }
  const listRef = useRef<HTMLDivElement | null>(null)
  const listPinnedRef = useRef(true)
  const toolsScrollKey = useMemo(
    () =>
      tools
        .map(
          (t) =>
            `${t.id}:${t.tool.status}:${t.tool.content?.length ?? 0}:${t.tool.summary ?? ''}`
        )
        .join('|'),
    [tools]
  )

  const listLive = isPending || live

  useEffect(() => {
    if (listLive) listPinnedRef.current = true
  }, [listLive])

  useEffect(() => {
    if (!listLive || singleTool) return
    const el = listRef.current
    if (!el || !listPinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [listLive, singleTool, toolsScrollKey])

  const onListScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget
    listPinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= LIST_PIN_PX
  }

  // While pending, tools own live phase detail; TurnSummary owns collapse +
  // elapsed. Group duration appears only once settled, as a static receipt.
  const elapsedDisplay = isPending ? '' : props.elapsedDisplay

  const headerLabel = isPending ? props.runningLabel : props.doneLabel

  if (singleTool && tools[0]) {
    const item = tools[0]
    const nested =
      nestedById.get(item.id) ??
      nestedById.get(item.tool.id) ??
      nestedTools[0] ?? {
        id: item.id,
        name: item.tool.name,
        category: toolCategory(item.tool.name),
        title: toolLabel(item.tool.name, item.tool.status, item.tool.content),
        subtitle: item.tool.summary?.trim() || '',
        status: item.tool.status
      }
    const hasBody = toolHasBody(item.tool, {
      toolProgress: item.toolProgress
    })
    const defaultExpanded = toolDefaultExpanded(item.tool.name, item.tool.status, live || keepOpen)
    // toolExpanded / localOverride win. Explicit groupExpanded (incl. false) is
    // honored even while running; otherwise use the tool's default expand.
    const isToolExpanded =
      item.toolExpanded ??
      localOverride ??
      (groupExpanded !== undefined ? groupExpanded : defaultExpanded)
    const toggleSingle = (): void => {
      if (!hasBody) return
      const next = !isToolExpanded
      // Prefer per-tool expand so controller toolExpanded survives live updates.
      if (onToolToggle) onToolToggle(item.id, next)
      else if (onGroupToggle) onGroupToggle(next)
      else setLocalOverride(next)
    }
    return (
      <div
        className={cn(ACTIVITY_ROW, 'tool-stagger-enter')}
        role="group"
        aria-busy={isPending || live || undefined}
        style={{ '--stagger-index': 0 } as CSSProperties}
      >
        <CompactRow
          title={nested.title}
          subtitle={nested.subtitle}
          status={nested.status}
          expanded={isToolExpanded}
          hasBody={hasBody}
          interrupted={isInterrupted}
          onToggle={toggleSingle}
        />
        <ExpandPanel open={hasBody && isToolExpanded}>
          <div className="tool-body-enter">
            <ToolRowOutput
              tool={item.tool}
              toolProgress={item.toolProgress}
              onLoadFullContent={onLoadFullContent}
              mcpServerNames={mcpServerNames}
              inGroup
              indent={false}
            />
          </div>
        </ExpandPanel>
      </div>
    )
  }

  return (
    <div className={ACTIVITY_ROW} role="group" aria-busy={isPending || live || undefined}>
      <button
        type="button"
        className={cn(DISCLOSURE_ROW, 'w-full text-left')}
        onClick={toggle}
        aria-expanded={expanded}
      >
        {isPending ? (
          <TextShimmer className="shrink-0 font-medium text-fg">{headerLabel}</TextShimmer>
        ) : (
          <span
            className={cn(
              'shrink-0 font-medium tool-status-morph',
              isInterrupted ? 'text-danger' : 'text-fg'
            )}
          >
            {headerLabel}
          </span>
        )}
        {summary ? (
          <span className="min-w-0 flex-1 truncate text-tertiary" title={summary}>
            {summary}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {isInterrupted ? <span className="text-danger">interrupted</span> : null}
          {elapsedDisplay ? (
            <span className="tabular-nums text-tertiary">{elapsedDisplay}</span>
          ) : null}
          <Icon
            name="chevronRight"
            size={14}
            className={cn('shrink-0 text-tertiary vy-transition', expanded && 'rotate-90')}
          />
        </span>
      </button>

      <ExpandPanel open={expanded}>
        <div
          ref={listRef}
          className={cn('flex flex-col gap-0.5 pl-2', listLive && TOOL_GROUP_LIST_VIEWPORT)}
          data-testid="tool-group-list"
          data-viewport-capped={listLive ? 'true' : undefined}
          onScroll={onListScroll}
        >
          {tools.map((item, index) => {
            const nested = nestedById.get(item.id)
            if (!nested) {
              return (
                <div
                  key={item.id}
                  className="tool-stagger-enter rounded-md px-2 py-1 text-xs text-muted"
                  style={{ '--stagger-index': index } as CSSProperties}
                  data-testid={`tool-group-fallback-${item.id}`}
                >
                  {item.tool.name}
                  {item.tool.status === 'running' ? '…' : ''}
                </div>
              )
            }
            const defaultExpanded = toolDefaultExpanded(item.tool.name, item.tool.status, live || keepOpen)
            const isToolExpanded =
              item.toolExpanded ?? (groupExpanded === false ? false : defaultExpanded)
            return (
              <NestedToolRow
                key={item.id}
                item={item}
                nested={nested}
                staggerIndex={index}
                isToolExpanded={isToolExpanded}
                onToolToggle={onToolToggle}
                onLoadFullContent={onLoadFullContent}
                mcpServerNames={mcpServerNames}
              />
            )
          })}
        </div>
      </ExpandPanel>
    </div>
  )
})
