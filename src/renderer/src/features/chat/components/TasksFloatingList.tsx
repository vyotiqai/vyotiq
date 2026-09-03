import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { useRunTodos } from '../hooks/useRunTodos'
import { pickCurrentTask, type TodoParsed } from '../toolUi/parsers/todo'
import { TodoStatusIcon } from './TodoChecklist'
import { TodoProgressBar } from './TasksCeilingBand'

const HOVER_OPEN_MS = 150
const HOVER_CLOSE_MS = 150
/** Fallbacks while the card has not measured yet. */
const CARD_WIDTH_FALLBACK_PX = 288
const CARD_HEIGHT_FALLBACK_PX = 180
const VIEWPORT_PAD_PX = 12
const CARD_GAP_PX = 8

type CardCoords = { top: number; left: number }

/**
 * The live plan control itself: status icon + done/total badge, with the
 * full task list streaming in a hover pop-up card. Todo data is passed in
 * so the rail's single poll feeds both the icon and the card.
 */
export function TasksRailButton({
  data,
  running = false,
  onOpenPlan,
  labelSuffix,
  className
}: {
  data: TodoParsed | null
  running?: boolean
  onOpenPlan: () => void
  /** Appended to the accessible name, e.g. " · Show plan panel". */
  labelSuffix?: string
  className?: string
}) {
  const cardId = useId()
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<CardCoords | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const items = data?.items ?? []
  const done = data?.done ?? 0
  const total = data?.total ?? 0
  const cancelled = items.filter((item) => item.status === 'cancelled').length
  const allDone = total > 0 && done === total
  const current = pickCurrentTask(items)
  const hasActive = current?.status === 'in_progress'
  const count = `${done}/${total}`

  const statusIcon: IconName = hasActive ? 'loader' : allDone ? 'check' : 'listTodo'
  const statusClass = hasActive
    ? 'text-accent motion-safe:animate-spin'
    : allDone
      ? 'text-success'
      : 'text-secondary'

  const ariaLabel = `Tasks ${done} of ${total}${current ? `. ${current.content}` : ''}${labelSuffix ?? ''}`

  const clearTimers = useCallback(() => {
    if (openTimerRef.current != null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const closeNow = useCallback(() => {
    clearTimers()
    setOpen(false)
  }, [clearTimers])

  const scheduleOpen = useCallback(() => {
    clearTimers()
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      setOpen(true)
    }, HOVER_OPEN_MS)
  }, [clearTimers])

  const scheduleClose = useCallback(() => {
    clearTimers()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, HOVER_CLOSE_MS)
  }, [clearTimers])

  const measure = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cardW = cardRef.current?.offsetWidth || CARD_WIDTH_FALLBACK_PX
    const cardH = cardRef.current?.offsetHeight || CARD_HEIGHT_FALLBACK_PX
    const left = Math.max(VIEWPORT_PAD_PX, rect.left - CARD_GAP_PX - cardW)
    const maxTop = Math.max(VIEWPORT_PAD_PX, window.innerHeight - cardH - VIEWPORT_PAD_PX)
    const top = Math.min(
      Math.max(VIEWPORT_PAD_PX, rect.top + rect.height / 2 - cardH / 2),
      maxTop
    )
    setCoords((prev) => (prev?.top === top && prev?.left === left ? prev : { top, left }))
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    measure()
    const raf = window.requestAnimationFrame(measure)
    return () => window.cancelAnimationFrame(raf)
  }, [open, measure, items.length])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      closeNow()
    }
    const onDocMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (cardRef.current?.contains(target)) return
      closeNow()
    }
    const onReposition = (): void => closeNow()
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('scroll', onReposition, true)
    window.addEventListener('resize', onReposition)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('scroll', onReposition, true)
      window.removeEventListener('resize', onReposition)
    }
  }, [open, closeNow])

  useEffect(() => clearTimers, [clearTimers])

  if (!data || items.length === 0) return null

  const card =
    open && coords ? (
      createPortal(
        <div
          ref={cardRef}
          id={cardId}
          role="dialog"
          aria-label={`Tasks ${done} of ${total}`}
          data-tasks-popover-card
          className="pointer-events-auto fixed z-tooltip w-72 rounded-xl border border-border bg-card p-3 shadow-menu animate-tip-in"
          style={{ top: coords.top, left: coords.left }}
          onPointerEnter={clearTimers}
          onPointerLeave={scheduleClose}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <TodoStatusIcon status={current?.status ?? 'pending'} size={14} />
            <span className="text-xs font-semibold text-fg">Tasks</span>
            {running ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-1.5 py-px text-2xs font-medium text-accent"
                data-tasks-popover-live
              >
                <span
                  className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
                  aria-hidden
                />
                Live
              </span>
            ) : null}
            <span className="ml-auto shrink-0 tabular-nums text-caption text-muted">
              {count}
            </span>
          </div>
          <TodoProgressBar done={done} total={total} className="mt-2" />
          {hasActive && current ? (
            <div
              className="mt-2 flex items-start gap-1.5 rounded-md border border-border/60 bg-surface px-2 py-1.5"
              data-tasks-popover-current
            >
              <TodoStatusIcon status="in_progress" size={12} className="mt-px" />
              <span className="min-w-0 flex-1 text-2xs font-medium leading-snug text-fg [overflow-wrap:anywhere]">
                {current.content}
              </span>
            </div>
          ) : null}
          <ul
            className="m-0 mt-2 max-h-56 list-none space-y-1 overflow-y-auto p-0"
            data-tasks-popover-list
          >
            {items.map((item, index) => (
              <li
                key={item.id ?? index}
                className={cn(
                  'flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-secondary',
                  item.status === 'in_progress' && 'font-medium text-fg',
                  item.status === 'completed' && 'text-muted',
                  item.status === 'cancelled' && 'text-muted line-through'
                )}
              >
                <TodoStatusIcon status={item.status} size={12} className="mt-px" />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.content}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/40 pt-2">
            <span className="min-w-0 truncate text-2xs tabular-nums text-muted">
              {`${done} of ${total} complete`}{cancelled > 0 ? ` · ${cancelled} skipped` : ''}
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium text-fg vy-transition hover:bg-surface"
              data-tasks-popover-open
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                closeNow()
                onOpenPlan()
              }}
            >
              Open plan panel
            </button>
          </div>
        </div>,
        document.body
      )
    ) : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-tasks-floating
        data-tasks-floating-chip
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={ariaLabel}
        className={cn(
          'relative inline-grid size-7 place-items-center rounded-md text-muted vy-transition hover:bg-surface hover:text-fg active:bg-surface-2',
          open && 'bg-surface text-fg',
          className
        )}
        onClick={() => {
          closeNow()
          onOpenPlan()
        }}
        onPointerEnter={scheduleOpen}
        onPointerLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
      >
        <span className="sr-only" role="status" aria-live="polite">
          {`Tasks ${done} of ${total}${current ? `. ${current.content}` : ''}${running ? '. Run in progress' : ''}`}
        </span>
        <Icon name={statusIcon} size={16} className={cn('shrink-0', statusClass)} />
        <span
          data-tasks-floating-count
          className={cn(
            'absolute -bottom-1 -right-1 rounded-full bg-bg px-1 text-[9px] font-semibold leading-[13px] tabular-nums ring-1 ring-border',
            allDone ? 'text-success' : 'text-fg'
          )}
        >
          {count}
        </span>
      </button>
      {card}
    </>
  )
}

/** Self-polling wrapper for standalone use (rail-less hosts, tests). */
export function TasksRailChip({
  workspacePath,
  runId,
  running = false,
  onOpenPlan,
  labelSuffix,
  className
}: {
  workspacePath: string | null
  runId: string | null
  running?: boolean
  onOpenPlan: () => void
  labelSuffix?: string
  className?: string
}) {
  const { data } = useRunTodos({
    workspacePath,
    runId,
    running,
    active: Boolean(workspacePath && runId),
    live: true
  })

  return (
    <TasksRailButton
      data={data}
      running={running}
      onOpenPlan={onOpenPlan}
      labelSuffix={labelSuffix}
      className={className}
    />
  )
}
