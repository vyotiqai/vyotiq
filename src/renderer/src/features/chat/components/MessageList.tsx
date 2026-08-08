import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import type { UiAgentQuestionAnswer, UiItem } from '@shared/transcript'
import type { ToolApprovalDecision } from '@shared/ipc'
import {
  CHAT_COLUMN,
  CHAT_GUTTER,
  CHAT_STAGE_INSET,
  TOOL_BODY_CLAMP_PX,
  TOOL_GROUP_LIST_MAX_PX,
  TOOL_TERMINAL_VIEWPORT_MAX_PX,
  TRANSCRIPT_ROW_GAP,
  TRANSCRIPT_TURN_GAP,
  TRANSCRIPT_WORK_PAIR_GAP,
  TRANSCRIPT_WORK_ROW_GAP
} from '@renderer/lib/utils/layout'
import {
  buildTranscriptRows,
  isTurnWorkRow,
  rowLeadingGap,
  stabilizeTranscriptRows,
  transcriptRowFingerprint,
  type TranscriptRow
} from '../utils/transcriptRows'
import { formatRunActivityLabel } from '../utils/runActivity'
import { ChangeSummary, COMPACT_PREVIEW_COUNT } from './ChangeSummary'
import { MessageFooter } from './MessageFooter'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolApprovalCard } from './ToolApprovalCard'
import { AskQuestionPanel } from './AskQuestionPanel'
import { ToolCard } from './ToolCard'
import { ToolGroup } from './ToolGroup'
import { TurnSummary } from './TurnSummary'
import { UserPrompt } from './UserPrompt'
import { MarkdownContent } from '@renderer/lib/ui'
import { shouldRenderThinking } from '@shared/transcript'
import { toolHasBody, toolDefaultExpanded } from '../toolUi'

/** Stable id on the first work row of a turn (region landmark / tests). */
function turnWorkPanelId(
  row: TranscriptRow,
  rows: readonly TranscriptRow[],
  index: number
): string | undefined {
  if (!isTurnWorkRow(row)) return undefined
  for (let i = 0; i < index; i += 1) {
    const prior = rows[i]!
    if (isTurnWorkRow(prior) && prior.turnIndex === row.turnIndex) return undefined
  }
  return `turn-work-${row.turnIndex}`
}

/** ~chars per visual line in the 840px chat column at text-sm. */
const CHARS_PER_LINE = 65
/** Line height for text-sm + leading-relaxed (1.625 × 13px). */
const LINE_PX = 21

/**
 * First-paint height guesses for the virtualizer.
 * Collapsed Thought/Read stay near disclosure height (~44–52). Text/user
 * must not under-estimate — that stacks absolute rows on top of each other.
 */
export function estimateTranscriptRowSize(
  row: TranscriptRow | undefined,
  options?: { liveTurn?: boolean; keepOpenTurn?: boolean }
): number {
  if (!row) return 48
  const preferOpen = Boolean(options?.liveTurn || options?.keepOpenTurn)
  switch (row.kind) {
    case 'turn':
      return 40
    case 'thinking':
      return row.item.thinkingStreaming || row.item.thinkingExpanded ? 116 : 44
    case 'user': {
      const len = row.item.content?.length ?? 0
      const media =
        (row.item.images?.length ?? 0) + (row.item.attachments?.length ?? 0)
      // UserPrompt clamps body at TOOL_BODY_CLAMP_PX when overflowing.
      const bodyLines = Math.max(1, Math.ceil(len / CHARS_PER_LINE))
      const body = Math.min(TOOL_BODY_CLAMP_PX, 28 + bodyLines * LINE_PX)
      const chrome = 40 + (media > 0 ? 36 : 0) + (len > 400 ? 22 : 0)
      return chrome + body
    }
    case 'text': {
      const content = row.item.content
      const newlines = content.split('\n').length
      const fromChars = Math.ceil(content.length / CHARS_PER_LINE)
      const lines = Math.max(1, newlines, fromChars)
      const base = 40 + lines * LINE_PX
      // Prefer slight overestimate over overlap; measureElement corrects mounted rows.
      if (row.item.streaming) return Math.min(1200, base)
      return Math.min(2400, base)
    }
    case 'activity': {
      const live = preferOpen || row.tools.some((t) => t.tool.status === 'running')
      const groupExpanded = row.tools[0]?.groupExpanded === true
      const toolExpanded = row.tools.some((t) => t.toolExpanded === true)
      const multi = row.tools.length > 1
      if (multi) {
        // Collapsed multi-tool groups ignore stale per-tool expand flags.
        if (live || groupExpanded) return 48 + TOOL_GROUP_LIST_MAX_PX
        return 48
      }
      const lone = row.tools[0]!
      const autoOpen = toolDefaultExpanded(lone.tool.name, lone.tool.status, live)
      // Lone running tools / todo_write auto-expand; file reads stay compact.
      if (autoOpen || toolExpanded || groupExpanded) {
        if (lone.tool.name === 'terminal') return 56 + TOOL_TERMINAL_VIEWPORT_MAX_PX
        return 56 + TOOL_BODY_CLAMP_PX
      }
      return 48
    }
    case 'card': {
      const live = preferOpen || row.item.tool.status === 'running'
      const expanded =
        row.item.toolExpanded === true || (live && row.item.toolExpanded !== false)
      const hasBody = toolHasBody(row.item.tool, {
        toolProgress: row.item.toolProgress
      })
      // Terminal output is always capped inside TOOL_TERMINAL_VIEWPORT — do not
      // add the old unbounded +80 fudge that assumed growing transcript height.
      if (row.item.tool.name === 'terminal') {
        if (expanded) return 56 + TOOL_TERMINAL_VIEWPORT_MAX_PX
        if (hasBody) return 56 + Math.min(TOOL_BODY_CLAMP_PX, TOOL_TERMINAL_VIEWPORT_MAX_PX)
        return 56
      }
      if (expanded) return 56 + TOOL_BODY_CLAMP_PX + 80
      // ProminentChrome still paints clamped body when collapsed + hasBody.
      if (hasBody) return 56 + TOOL_BODY_CLAMP_PX
      return 56
    }
    case 'changes': {
      // Compact receipt: header + preview rows (+ optional Show more footer).
      const preview = Math.min(row.files.length, COMPACT_PREVIEW_COUNT)
      const moreFooter = row.files.length > COMPACT_PREVIEW_COUNT ? 28 : 0
      return 40 + preview * 28 + moreFooter
    }
    case 'approval':
      return 120
    case 'question':
      return 160
    case 'run_error':
      return 72
    default: {
      const _exhaustive: never = row
      return _exhaustive
    }
  }
}

/** Cheap revision string so streaming content growth remasures without a length change. */
export function transcriptRowsContentRevision(rows: readonly TranscriptRow[]): string {
  if (rows.length === 0) return ''
  return rows.map((row) => transcriptRowFingerprint(row)).join('\n')
}

/** Minimum pin slack when no dock reserve is known yet. */
const NEAR_BOTTOM_MIN_PX = 80

/**
 * Virtualize only long idle transcripts that never streamed in this mount.
 * Live runs (and the idle view right after them) stay in document flow so a
 * cold virtualizer cannot invent black gaps / overlapping translateY slots.
 */
const VIRTUALIZE_MIN_ROWS = 160

/**
 * During a live run, keep only this many trailing rows in document flow. Older
 * rows in the same turn are virtualized — one user prompt with dozens of agent
 * steps otherwise mounts the entire transcript and freezes the renderer.
 */
const HYBRID_FLOW_TAIL_ROWS = 40

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

function nearBottomThreshold(): number {
  return NEAR_BOTTOM_MIN_PX
}

/** Structure for tail-follow — ids only; tool status churn must not yank scroll. */
function structuralKey(items: UiItem[]): string {
  return items.map((item) => item.id).join('|')
}

function ImageLightbox({ url, label, onClose }: { url: string; label: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    closeRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      // Single focusable control in the dialog — keep focus trapped on Close.
      e.preventDefault()
      closeRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocusRef.current?.focus?.()
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        className="absolute right-4 top-4 inline-grid size-8 place-items-center rounded-full bg-black/50 text-white vy-transition hover:bg-black/70"
        aria-label="Close image preview"
        onClick={onClose}
      >
        <Icon name="close" size={16} />
      </button>
      <img
        src={url}
        alt={label}
        className="max-h-[min(90vh,900px)] max-w-[min(92vw,1200px)] rounded-md object-contain shadow-lg"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

/** Spacing as padding (not margin) so row rhythm stays consistent. */
function rowSpacingClass(row: TranscriptRow, next?: TranscriptRow): string {
  if (row.kind === 'turn') {
    return cn('pt-1', TRANSCRIPT_ROW_GAP)
  }
  const isWork =
    row.kind === 'activity' ||
    row.kind === 'thinking' ||
    row.kind === 'card' ||
    row.kind === 'changes'
  const tightPair =
    (row.kind === 'thinking' && (next?.kind === 'activity' || next?.kind === 'card')) ||
    ((row.kind === 'activity' || row.kind === 'card') && next?.kind === 'thinking')
  const gap = tightPair
    ? TRANSCRIPT_WORK_PAIR_GAP
    : isWork
      ? TRANSCRIPT_WORK_ROW_GAP
      : TRANSCRIPT_ROW_GAP
  return cn(gap, rowLeadingGap(row) > 0 && TRANSCRIPT_TURN_GAP)
}

const TranscriptRowBlock = memo(function TranscriptRowBlock({
  row,
  onImageClick,
  onLoadToolContent,
  onThinkingToggle,
  onToolToggle,
  onGroupToggle,
  onTurnToggle,
  onApprovalDecision,
  onQuestionSubmit,
  turnCollapsed = false,
  showThinking = true,
  live = false,
  keepOpen = false,
  mcpServerNames,
  onOpenChanges,
  editingUserMessageIndex = null,
  editComposer,
  onBeginEditUserMessage,
  onRevertUserMessage,
  messageCount = 0,
  running = false,
  pendingRun = false
}: {
  row: TranscriptRow
  onImageClick: (url: string, label: string) => void
  onLoadToolContent?: (toolCallId: string) => Promise<string | null>
  onThinkingToggle?: (messageId: string, expanded: boolean) => void
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onGroupToggle?: (anchorToolCallId: string, expanded: boolean) => void
  onTurnToggle?: (turnIndex: number) => void
  onApprovalDecision?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  onQuestionSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
  turnCollapsed?: boolean
  showThinking?: boolean
  live?: boolean
  /** Last turn stays expanded after settle so tool chrome remains visible. */
  keepOpen?: boolean
  mcpServerNames?: ReadonlyMap<string, string>
  onOpenChanges?: () => void
  editingUserMessageIndex?: number | null
  editComposer?: ReactNode
  onBeginEditUserMessage?: (messageIndex: number) => void
  onRevertUserMessage?: (messageIndex: number) => void
  messageCount?: number
  running?: boolean
  pendingRun?: boolean
}) {
  if (row.kind === 'user') {
    const match = /^user-(\d+)$/.exec(row.item.id)
    const userIndex = match ? Number(match[1]) : -1
    const canRevert =
      userIndex >= 0 &&
      messageCount > userIndex + 1 &&
      !running &&
      !pendingRun &&
      editingUserMessageIndex == null
    return (
      <UserPrompt
        item={row.item}
        onImageClick={onImageClick}
        editing={editingUserMessageIndex != null && row.item.id === `user-${editingUserMessageIndex}`}
        editComposer={
          editingUserMessageIndex != null && row.item.id === `user-${editingUserMessageIndex}`
            ? editComposer
            : undefined
        }
        onBeginEdit={
          onBeginEditUserMessage && editingUserMessageIndex == null
            ? () => {
                if (userIndex < 0) return
                onBeginEditUserMessage(userIndex)
              }
            : undefined
        }
        canRevert={canRevert}
        onRevert={
          onRevertUserMessage && canRevert
            ? () => {
                if (userIndex < 0) return
                onRevertUserMessage(userIndex)
              }
            : undefined
        }
      />
    )
  }

  if (row.kind === 'turn') {
    return (
      <TurnSummary
        span={row.span}
        collapsed={turnCollapsed}
        onToggle={() => onTurnToggle?.(row.turnIndex)}
      />
    )
  }

  if (row.kind === 'thinking') {
    if (!showThinking) return null
    return (
      <ThinkingBlock
        content={row.item.thinking ?? ''}
        streaming={row.item.thinkingStreaming}
        expanded={row.item.thinkingExpanded}
        onToggle={(next) => onThinkingToggle?.(row.item.id, next)}
      />
    )
  }

  if (row.kind === 'text') {
    return (
      <div className="group/message">
        {row.item.reconnecting ? (
          <p className="m-0 mb-1 text-caption text-secondary" role="status">
            Reconnecting…
          </p>
        ) : null}
        <MarkdownContent content={row.item.content} streaming={row.item.streaming} />
        {row.final && !row.item.streaming ? (
          <MessageFooter content={row.item.content} at={row.item.at} />
        ) : null}
      </div>
    )
  }

  if (row.kind === 'run_error') {
    return (
      <div
        className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger [overflow-wrap:anywhere]"
        role="alert"
      >
        {row.message}
      </div>
    )
  }

  if (row.kind === 'changes') {
    // Receipt only — Keep/Discard lives in the Changes panel (Review).
    return <ChangeSummary files={row.files} compact onOpenChanges={onOpenChanges} />
  }

  if (row.kind === 'approval') {
    return <ToolApprovalCard approval={row.approval} onDecide={onApprovalDecision} />
  }

  if (row.kind === 'question') {
    return <AskQuestionPanel question={row.question} onSubmit={onQuestionSubmit} />
  }

  if (row.kind === 'activity') {
    // Prefer per-item toolExpanded so siblings keep familyDefaultExpanded when
    // only one tool has an explicit expand flag (do not pass a Set that blanks them).
    const anchor = row.tools[0]!
    return (
      <ToolGroup
        tools={row.tools}
        groupExpanded={anchor.groupExpanded}
        live={live}
        keepOpen={keepOpen}
        onGroupToggle={
          onGroupToggle ? (expanded) => onGroupToggle(anchor.id, expanded) : undefined
        }
        onToolToggle={onToolToggle}
        onLoadFullContent={onLoadToolContent}
        mcpServerNames={mcpServerNames}
      />
    )
  }

  if (row.kind === 'card') {
    return (
      <ToolCard
        item={row.item}
        expanded={row.item.toolExpanded}
        live={live}
        keepOpen={keepOpen}
        // Without a host that persists the choice the card owns its own state,
        // so it still opens instead of swallowing the click.
        onToggle={onToolToggle ? (next) => onToolToggle(row.item.id, next) : undefined}
        onLoadFullContent={onLoadToolContent}
        mcpServerNames={mcpServerNames}
      />
    )
  }

  return null
})

export function MessageList({
  items,
  restoreScrollTop,
  scrollRestoreToken,
  onScrollTopChange,
  onActivate,
  onLoadToolContent,
  onThinkingToggle,
  onToolToggle,
  onGroupToggle,
  onTurnToggle,
  onApprovalDecision,
  onQuestionSubmit,
  collapsedTurns,
  showThinking = true,
  mcpServerNames,
  pendingRun = false,
  running = false,
  networkWait = null,
  turnFailed = false,
  turnFailureLabel = null,
  transcriptLoading = false,
  onOpenChanges,
  sideRailPad = true,
  editingUserMessageIndex = null,
  editComposer,
  onBeginEditUserMessage,
  onRevertUserMessage,
  messageCount = 0
}: {
  items: UiItem[]
  restoreScrollTop?: number
  scrollRestoreToken?: number
  onScrollTopChange?: (scrollTop: number) => void
  onActivate?: () => void
  onLoadToolContent?: (toolCallId: string) => Promise<string | null>
  onThinkingToggle?: (messageId: string, expanded: boolean) => void
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onGroupToggle?: (anchorToolCallId: string, expanded: boolean) => void
  onTurnToggle?: (turnIndex: number) => void
  onApprovalDecision?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  onQuestionSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
  /** Persisted turn-summary collapse state from the chat stream controller. */
  collapsedTurns?: ReadonlySet<number>
  showThinking?: boolean
  mcpServerNames?: ReadonlyMap<string, string>
  pendingRun?: boolean
  running?: boolean
  networkWait?: {
    attempt: number
    maxAttempts: number
    retryInMs: number
    code?: string
  } | null
  turnFailed?: boolean
  turnFailureLabel?: string | null
  /** True while the selected chat transcript is still loading. */
  transcriptLoading?: boolean
  onOpenChanges?: () => void
  /** When false, use symmetric gutter (immersive Agent — no floating side rail). */
  sideRailPad?: boolean
  editingUserMessageIndex?: number | null
  editComposer?: ReactNode
  onBeginEditUserMessage?: (messageIndex: number) => void
  onRevertUserMessage?: (messageIndex: number) => void
  messageCount?: number
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const appliedRestoreRef = useRef<number | null>(null)
  const restoreScrollTopRef = useRef(restoreScrollTop ?? 0)
  const restorePendingRef = useRef(Boolean(restoreScrollTop && restoreScrollTop > 0))
  const pinnedToBottomRef = useRef(true)
  const programmaticScrollRef = useRef(false)
  const autoScrollRafRef = useRef<number | null>(null)
  const [scrollRestored, setScrollRestored] = useState(
    () => !restoreScrollTop || restoreScrollTop <= 0
  )
  const [isUnpinned, setIsUnpinned] = useState(false)
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null)
  /** Topmost visible row while in flow layout — restores position after virtualization flips on. */
  const flowAnchorRef = useRef<{ index: number; offsetPx: number } | null>(null)
  const shouldVirtualizeRef = useRef(false)
  const collapsedTurnSet = useMemo(
    () => collapsedTurns ?? new Set<number>(),
    [collapsedTurns]
  )
  const prevStructuralKeyRef = useRef<string | null>(null)
  const prevRowsRef = useRef<TranscriptRow[] | null>(null)
  /** After a live run ends, keep flow layout briefly so height settles before virtualizing. */
  const [stayInFlowAfterLive, setStayInFlowAfterLive] = useState(false)
  const wasLiveRef = useRef(false)
  useEffect(() => {
    const live = pendingRun || running
    if (live) {
      wasLiveRef.current = true
      setStayInFlowAfterLive(false)
      return
    }
    if (!wasLiveRef.current) {
      setStayInFlowAfterLive(false)
      return
    }
    setStayInFlowAfterLive(true)
    const timer = window.setTimeout(() => {
      setStayInFlowAfterLive(false)
      wasLiveRef.current = false
    }, 800)
    return () => window.clearTimeout(timer)
  }, [pendingRun, running])

  const itemsStructuralKey = useMemo(() => structuralKey(items), [items])
  const allRows = useMemo(() => {
    const next = buildTranscriptRows(items, {
      pendingRun,
      running,
      showThinking,
      networkWait,
      turnFailed,
      turnFailureLabel
    })
    return stabilizeTranscriptRows(prevRowsRef.current, next)
  }, [items, pendingRun, running, showThinking, networkWait, turnFailed, turnFailureLabel])
  useLayoutEffect(() => {
    prevRowsRef.current = allRows
  }, [allRows])
  const displayRows = useMemo(() => {
    const visible = collapsedTurnSet.size === 0
      ? allRows
      : allRows.filter((row) => !(collapsedTurnSet.has(row.turnIndex) && isTurnWorkRow(row)))
    // Hide thinking when showThinking is off; otherwise drop empty rows ThinkingBlock skips.
    if (!showThinking) {
      return visible.filter((row) => row.kind !== 'thinking')
    }
    return visible.filter((row) => {
      if (row.kind !== 'thinking') return true
      return shouldRenderThinking(row.item.thinking, row.item.thinkingStreaming)
    })
  }, [allRows, collapsedTurnSet, showThinking])

  const activeLiveTurnIndex = useMemo(() => {
    if (!(pendingRun || running)) return null
    let max = -1
    for (const row of allRows) {
      if (row.turnIndex > max) max = row.turnIndex
    }
    return max < 0 ? null : max
  }, [allRows, pendingRun, running])

  const lastTurnIndex = useMemo(() => {
    let max = -1
    for (const row of allRows) {
      if (row.turnIndex > max) max = row.turnIndex
    }
    return max
  }, [allRows])

  const nearBottomPx = nearBottomThreshold()
  const nearBottomPxRef = useRef(nearBottomPx)
  nearBottomPxRef.current = nearBottomPx

  restoreScrollTopRef.current = restoreScrollTop ?? 0

  const onImageClick = useCallback((url: string, label: string) => {
    setLightbox({ url, label })
  }, [])
  const closeLightbox = useCallback(() => setLightbox(null), [])

  const handleTurnToggle = useCallback(
    (turnIndex: number) => {
      onTurnToggle?.(turnIndex)
    },
    [onTurnToggle]
  )

  useLayoutEffect(() => {
    appliedRestoreRef.current = null
    const top = restoreScrollTopRef.current
    restorePendingRef.current = Boolean(top && top > 0)
    setScrollRestored(!top || top <= 0)
  }, [scrollRestoreToken])

  useLayoutEffect(() => {
    const top = restoreScrollTopRef.current
    if (!top || top <= 0) {
      restorePendingRef.current = false
      setScrollRestored(true)
      pinnedToBottomRef.current = true
      return
    }
    const el = containerRef.current
    if (!el) return

    const applyRestore = (): void => {
      if (!restorePendingRef.current && appliedRestoreRef.current === (scrollRestoreToken ?? 0)) {
        return
      }
      programmaticScrollRef.current = true
      el.scrollTop = top
      const contentTall = el.scrollHeight > el.clientHeight + nearBottomPxRef.current
      pinnedToBottomRef.current = !contentTall || distanceFromBottom(el) <= nearBottomPxRef.current
      appliedRestoreRef.current = scrollRestoreToken ?? 0
      setScrollRestored(true)
      restorePendingRef.current = false
      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    }

    const id = window.requestAnimationFrame(applyRestore)
    return () => window.cancelAnimationFrame(id)
  }, [scrollRestoreToken])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!restorePendingRef.current) return
      const top = restoreScrollTopRef.current
      if (!top || top <= 0) {
        restorePendingRef.current = false
        return
      }
      programmaticScrollRef.current = true
      el.scrollTop = top
      const contentTall = el.scrollHeight > el.clientHeight + nearBottomPxRef.current
      pinnedToBottomRef.current = !contentTall || distanceFromBottom(el) <= nearBottomPxRef.current
      restorePendingRef.current = false
      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    })
    ro.observe(el)
    const inner = el.firstElementChild
    if (inner) ro.observe(inner)
    return () => ro.disconnect()
  }, [scrollRestoreToken])

  useEffect(() => {
    return () => {
      if (autoScrollRafRef.current) window.cancelAnimationFrame(autoScrollRafRef.current)
    }
  }, [])

  const followTail = useCallback((behavior: ScrollBehavior) => {
    const el = containerRef.current
    if (!el) return
    programmaticScrollRef.current = true
    // Scroll to the true end (includes paddingBottom when composer space is reserved).
    const top = el.scrollHeight
    if (behavior === 'smooth' && typeof el.scrollTo === 'function') {
      el.scrollTo({ top, behavior: 'smooth' })
    } else {
      el.scrollTop = top
    }
    pinnedToBottomRef.current = true
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [])

  const jumpToBottom = useCallback(() => {
    restorePendingRef.current = false
    setIsUnpinned(false)
    followTail('smooth')
  }, [followTail])

  const scheduleTailFollow = useCallback(() => {
    if (autoScrollRafRef.current) window.cancelAnimationFrame(autoScrollRafRef.current)
    autoScrollRafRef.current = window.requestAnimationFrame(() => {
      autoScrollRafRef.current = null
      if (!scrollRestored || restorePendingRef.current || !pinnedToBottomRef.current) return
      const el = containerRef.current
      // Only skip when already flush at the absolute bottom. Skipping for the
      // whole dock slack can leave streaming growth below the visible fold.
      if (el && distanceFromBottom(el) < 1) return
      followTail('auto')
    })
  }, [followTail, scrollRestored])

  useEffect(() => {
    if (!scrollRestored || restorePendingRef.current || !pinnedToBottomRef.current) return
    if (prevStructuralKeyRef.current === itemsStructuralKey) return
    prevStructuralKeyRef.current = itemsStructuralKey
    scheduleTailFollow()
  }, [itemsStructuralKey, scheduleTailFollow, scrollRestored])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!scrollRestored || restorePendingRef.current || !pinnedToBottomRef.current) return
      scheduleTailFollow()
    })
    ro.observe(el)
    const inner = el.firstElementChild
    if (inner) ro.observe(inner)
    return () => ro.disconnect()
  }, [scheduleTailFollow, scrollRestored])

  const captureFlowAnchor = useCallback((el: HTMLElement): void => {
    const column = el.querySelector('[data-chat-column], [data-live-turn-flow]')
    if (!column) return
    const containerTop = el.getBoundingClientRect().top
    const children = column.children
    for (let i = 0; i < children.length; i++) {
      const rect = children[i]!.getBoundingClientRect()
      if (rect.bottom > containerTop + 1) {
        flowAnchorRef.current = { index: i, offsetPx: containerTop - rect.top }
        return
      }
    }
    flowAnchorRef.current = null
  }, [])

  const handleScroll = useCallback(
    (scrollTop: number) => {
      const el = containerRef.current
      if (el && !programmaticScrollRef.current) {
        const pinned = distanceFromBottom(el) <= nearBottomPxRef.current
        pinnedToBottomRef.current = pinned
        restorePendingRef.current = false
        setIsUnpinned((prev) => (prev === !pinned ? prev : !pinned))
        if (!shouldVirtualizeRef.current) captureFlowAnchor(el)
      }
      onScrollTopChange?.(scrollTop)
    },
    [captureFlowAnchor, onScrollTopChange]
  )

  const streamingAnnouncement = useMemo(() => {
    for (const row of displayRows) {
      if (row.kind === 'text' && row.item.streaming) {
        return `Assistant: ${formatRunActivityLabel({ kind: 'writing' })}`
      }
      if (row.kind === 'thinking' && row.item.thinkingStreaming) {
        return `Assistant: ${formatRunActivityLabel({ kind: 'thinking' })}`
      }
    }
    for (let i = allRows.length - 1; i >= 0; i--) {
      const row = allRows[i]
      if (row?.kind !== 'turn' || !row.span.activity) continue
      return `Assistant: ${formatRunActivityLabel(row.span.activity)}`
    }
    return ''
  }, [displayRows, allRows])

  const rowsContentRevision = useMemo(
    () => transcriptRowsContentRevision(displayRows),
    [displayRows]
  )

  // Streaming text_delta keeps the same item id, so structuralKey alone misses
  // content growth. Re-pin while live when the user is already at the tail.
  useEffect(() => {
    if (!running && !pendingRun) return
    if (!scrollRestored || restorePendingRef.current || !pinnedToBottomRef.current) return
    scheduleTailFollow()
  }, [rowsContentRevision, running, pendingRun, scheduleTailFollow, scrollRestored])

  const useHybridVirtualize =
    (pendingRun || running) &&
    !stayInFlowAfterLive &&
    displayRows.length >= VIRTUALIZE_MIN_ROWS &&
    activeLiveTurnIndex != null

  const flowStartIndex = useMemo(() => {
    if (!useHybridVirtualize || activeLiveTurnIndex == null) return displayRows.length
    const turnStartIdx = displayRows.findIndex((row) => row.turnIndex >= activeLiveTurnIndex)
    const turnBased = turnStartIdx < 0 ? displayRows.length : turnStartIdx
    const tailStart = Math.max(0, displayRows.length - HYBRID_FLOW_TAIL_ROWS)
    return Math.max(turnBased, tailStart)
  }, [useHybridVirtualize, displayRows, activeLiveTurnIndex])

  const useFullVirtualize =
    !pendingRun && !running && !stayInFlowAfterLive && displayRows.length >= VIRTUALIZE_MIN_ROWS

  const virtualizedRows = useMemo(() => {
    if (useHybridVirtualize && flowStartIndex > 0) {
      return displayRows.slice(0, flowStartIndex)
    }
    if (useFullVirtualize) return displayRows
    return []
  }, [useHybridVirtualize, flowStartIndex, useFullVirtualize, displayRows])

  const flowSuffixRows = useMemo(() => {
    if (useHybridVirtualize && flowStartIndex > 0) {
      return displayRows.slice(flowStartIndex)
    }
    return []
  }, [useHybridVirtualize, flowStartIndex, displayRows])

  const getItemKey = useCallback(
    (index: number) => virtualizedRows[index]?.id ?? index,
    [virtualizedRows]
  )

  const estimateSize = useCallback(
    (index: number) => {
      const row = virtualizedRows[index]
      const turnIndex = row?.turnIndex
      return estimateTranscriptRowSize(row, {
        liveTurn: activeLiveTurnIndex != null && turnIndex === activeLiveTurnIndex,
        keepOpenTurn: lastTurnIndex >= 0 && turnIndex === lastTurnIndex
      })
    },
    [virtualizedRows, activeLiveTurnIndex, lastTurnIndex]
  )

  const measureElementHeight = useCallback((element: Element) => {
    // offsetHeight includes padding/border and avoids transform-skewed rects.
    if (element instanceof HTMLElement && element.offsetHeight > 0) {
      return element.offsetHeight
    }
    return element.getBoundingClientRect().height
  }, [])

  const shouldVirtualize = virtualizedRows.length > 0
  shouldVirtualizeRef.current = shouldVirtualize

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? virtualizedRows.length : 0,
    getScrollElement: () => containerRef.current,
    estimateSize,
    measureElement: measureElementHeight,
    getItemKey,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: nearBottomPx,
    overscan: 8,
    enabled: shouldVirtualize,
    // jsdom / first paint often report 0×0 until layout; seed a viewport so rows mount.
    initialRect: { width: 720, height: 800 }
  })

  const remasureMountedRows = useCallback(() => {
    const root = containerRef.current
    if (!root) return
    const nodes = root.querySelectorAll('[data-index]')
    for (const node of nodes) {
      rowVirtualizer.measureElement(node)
    }
  }, [rowVirtualizer])

  // Never call measure() here — it clears itemSizeCache and off-screen rows fall
  // back to estimates (huge gaps between Thought/Read). Remasure mounted only.
  useLayoutEffect(() => {
    if (!shouldVirtualize) return
    remasureMountedRows()
  }, [displayRows.length, scrollRestored, shouldVirtualize, remasureMountedRows])

  // Flow → virtualized flip: keep the topmost visible row at the same offset so
  // an unpinned reader does not jump when estimates replace real heights.
  const wasVirtualizingRef = useRef(false)
  useLayoutEffect(() => {
    const turnedOn = shouldVirtualize && !wasVirtualizingRef.current
    wasVirtualizingRef.current = shouldVirtualize
    if (!turnedOn || pinnedToBottomRef.current) return
    const anchor = flowAnchorRef.current
    if (!anchor) return
    remasureMountedRows()
    programmaticScrollRef.current = true
    rowVirtualizer.scrollToIndex(anchor.index, { align: 'start' })
    const el = containerRef.current
    if (el) el.scrollTop += anchor.offsetPx
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [shouldVirtualize, remasureMountedRows, rowVirtualizer])

  useLayoutEffect(() => {
    if (!shouldVirtualize) return
    remasureMountedRows()
  }, [rowsContentRevision, shouldVirtualize, remasureMountedRows])

  useLayoutEffect(() => {
    if (!scrollRestored || displayRows.length === 0) return
    if (restoreScrollTop && restoreScrollTop > 0) return
    if (shouldVirtualize) {
      // Remasure visible rows first so end scroll uses real heights, not cold estimates.
      remasureMountedRows()
    }
    // Scroll to scrollHeight (includes paddingBottom when reserved). Avoid
    // virtualizer scrollToEnd — it aligns to the client bottom and can undershoot
    // when padding is reserved. Do not use followTail here: it sets
    // programmaticScrollRef and can swallow the user's immediate unpin scroll.
    // Only force the pin when the user is already at the tail — shouldVirtualize
    // can flip long after mount and must not yank a scrolled-up reader down.
    const el = containerRef.current
    if (el && pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight
      pinnedToBottomRef.current = true
    }
    // Pin once after restore/surface — followOnAppend handles stream growth.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot pin
  }, [scrollRestored, scrollRestoreToken, shouldVirtualize])

  const renderRow = (row: TranscriptRow): ReactNode => (
    <TranscriptRowBlock
      row={row}
      onImageClick={onImageClick}
      onLoadToolContent={onLoadToolContent}
      onThinkingToggle={onThinkingToggle}
      onToolToggle={onToolToggle}
      onGroupToggle={onGroupToggle}
      onTurnToggle={handleTurnToggle}
      onApprovalDecision={onApprovalDecision}
      onQuestionSubmit={onQuestionSubmit}
      turnCollapsed={collapsedTurnSet.has(row.turnIndex)}
      showThinking={showThinking}
      live={activeLiveTurnIndex != null && row.turnIndex === activeLiveTurnIndex}
      keepOpen={lastTurnIndex >= 0 && row.turnIndex === lastTurnIndex}
      mcpServerNames={mcpServerNames}
      onOpenChanges={onOpenChanges}
      editingUserMessageIndex={editingUserMessageIndex}
      editComposer={editComposer}
      onBeginEditUserMessage={onBeginEditUserMessage}
      onRevertUserMessage={onRevertUserMessage}
      messageCount={messageCount}
      running={running}
      pendingRun={pendingRun}
    />
  )

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={containerRef}
          data-transcript-scroll
          className={cn(
            'relative min-h-0 flex-1 overflow-auto pt-4 [scrollbar-gutter:stable]',
            sideRailPad ? CHAT_STAGE_INSET : CHAT_GUTTER
          )}
          onScroll={(e) => handleScroll(e.currentTarget.scrollTop)}
          onPointerDownCapture={() => onActivate?.()}
          onFocus={() => onActivate?.()}
        >
          <div className="sr-only" role="status" aria-live="polite">
            {streamingAnnouncement}
          </div>
          {transcriptLoading && items.length === 0 ? (
            <div
              className={cn(
                CHAT_COLUMN,
                'flex min-h-[12rem] flex-col items-center justify-center gap-2 text-sm text-muted'
              )}
              role="status"
              aria-busy="true"
            >
              <Icon name="loader" size={16} className="motion-safe:animate-spin" />
              <span>Loading chat…</span>
            </div>
          ) : (
            (() => {
              // Short transcripts: normal flow — no absolute translateY collision risk.
              // Long transcripts / Vitest empty-range: virtualize or full-DOM test fallback.
              const virtualItems = shouldVirtualize ? rowVirtualizer.getVirtualItems() : []
              const allowFullFallback =
                typeof process !== 'undefined' && process.env.VITEST === 'true'
              const useHybridLayout = shouldVirtualize && flowSuffixRows.length > 0
              const useFlowLayout =
                !shouldVirtualize ||
                (virtualItems.length === 0 &&
                  displayRows.length > 0 &&
                  allowFullFallback &&
                  flowSuffixRows.length === 0)

              const loadingOverlay =
                transcriptLoading && items.length > 0 ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
                    role="status"
                    aria-busy="true"
                  >
                    <span className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1 text-caption text-muted shadow-sm">
                      <Icon name="loader" size={12} className="motion-safe:animate-spin" />
                      Loading chat…
                    </span>
                  </div>
                ) : null

              if (useFlowLayout) {
                return (
                  <>
                    {loadingOverlay}
                    <div className={cn('flex w-full flex-col', CHAT_COLUMN)} data-chat-column>
                      {displayRows.map((row, index) => (
                        <div
                          key={row.id}
                          id={turnWorkPanelId(row, displayRows, index)}
                          className={rowSpacingClass(row, displayRows[index + 1])}
                        >
                          {renderRow(row)}
                        </div>
                      ))}
                    </div>
                  </>
                )
              }
              if (useHybridLayout) {
                return (
                  <>
                    {loadingOverlay}
                    <div
                      className={cn('relative w-full', CHAT_COLUMN)}
                      data-chat-column
                      style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                    >
                      {virtualItems.map((virtualItem) => {
                        const row = virtualizedRows[virtualItem.index]!
                        return (
                          <div
                            key={virtualItem.key}
                            data-index={virtualItem.index}
                            ref={rowVirtualizer.measureElement}
                            id={turnWorkPanelId(row, displayRows, virtualItem.index)}
                            className={cn(
                              'absolute left-0 top-0 w-full',
                              rowSpacingClass(row, displayRows[virtualItem.index + 1])
                            )}
                            style={{ transform: `translateY(${virtualItem.start}px)` }}
                          >
                            {renderRow(row)}
                          </div>
                        )
                      })}
                    </div>
                    <div className={cn('flex w-full flex-col', CHAT_COLUMN)} data-live-turn-flow>
                      {flowSuffixRows.map((row, localIndex) => {
                        const index = flowStartIndex + localIndex
                        return (
                          <div
                            key={row.id}
                            id={turnWorkPanelId(row, displayRows, index)}
                            className={rowSpacingClass(row, displayRows[index + 1])}
                          >
                            {renderRow(row)}
                          </div>
                        )
                      })}
                    </div>
                  </>
                )
              }
              return (
                <>
                  {loadingOverlay}
                  <div
                    className={cn('relative w-full', CHAT_COLUMN)}
                    data-chat-column
                    style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                  >
                    {virtualItems.map((virtualItem) => {
                      const row = virtualizedRows[virtualItem.index]!
                      return (
                        <div
                          key={virtualItem.key}
                          data-index={virtualItem.index}
                          ref={rowVirtualizer.measureElement}
                          id={turnWorkPanelId(row, displayRows, virtualItem.index)}
                          className={cn(
                            'absolute left-0 top-0 w-full',
                            rowSpacingClass(row, displayRows[virtualItem.index + 1])
                          )}
                          style={{ transform: `translateY(${virtualItem.start}px)` }}
                        >
                          {renderRow(row)}
                        </div>
                      )
                    })}
                  </div>
                </>
              )
            })()
          )}
          {isUnpinned ? (
            <div
              className="pointer-events-none sticky bottom-4 z-dropdown flex h-0 justify-end pr-2"
              data-jump-to-bottom
            >
              <button
                type="button"
                onClick={jumpToBottom}
                aria-label="Jump to latest messages"
                className="pointer-events-auto inline-flex -translate-y-full items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1.5 text-caption text-secondary shadow-md vy-transition hover:bg-surface-2 hover:text-fg"
              >
                <Icon name="chevron" size={12} />
                Latest
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {lightbox ? (
        <ImageLightbox
          url={lightbox.url}
          label={lightbox.label}
          onClose={closeLightbox}
        />
      ) : null}
    </>
  )
}
