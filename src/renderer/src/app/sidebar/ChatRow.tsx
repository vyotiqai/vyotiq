import { memo, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import type { RunSummary } from '@shared/ipc'
import { relativeTime } from '@shared/timeFormat'
import { InlineConfirmActions } from './InlineConfirmActions'
import { runTitle, runTooltip } from './runTitle'

function RunStatusDot({ status }: { status: RunSummary['status'] }) {
  if (status === 'running') {
    return (
      <span className="size-1.5 shrink-0 rounded-full bg-fg motion-safe:animate-pulse" title="Running">
        <span className="sr-only">Running</span>
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="size-1.5 shrink-0 rounded-full bg-danger" title="Error">
        <span className="sr-only">Error</span>
      </span>
    )
  }
  return null
}

function RowActionButton({
  label,
  icon,
  className,
  onClick
}: {
  label: string
  icon: IconName
  className?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'app-region-no-drag inline-grid size-6 place-items-center rounded text-muted vy-transition hover:bg-surface hover:text-fg',
        className
      )}
      aria-label={label}
      title={label}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <Icon name={icon} size={14} />
    </button>
  )
}

export const ChatRow = memo(function ChatRow({
  run,
  active,
  onSelect,
  onRename,
  onDelete
}: {
  run: RunSummary
  active: boolean
  onSelect: () => void
  onRename: (goal: string) => void
  onDelete: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [draft, setDraft] = useState(run.goal ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const renameCancelledRef = useRef(false)

  useEffect(() => {
    if (!renaming) return
    renameCancelledRef.current = false
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [renaming])

  useEffect(() => {
    if (!renaming) setDraft(run.goal ?? '')
  }, [run.goal, renaming])

  const commitRename = (): void => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      return
    }
    const next = draft.trim()
    setRenaming(false)
    if (next && next !== (run.goal ?? '').trim()) onRename(next)
  }

  const title = runTitle(run)
  const fullLabel = runTooltip(run)

  if (renaming) {
    return (
      <div role="listitem" className="px-0.5 py-0.5">
        <input
          ref={inputRef}
          type="text"
          className="app-region-no-drag w-full rounded-md border border-border bg-surface px-1.5 py-1 text-[13px] text-fg outline-none focus:vy-focus-ring"
          value={draft}
          aria-label="Rename chat"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') {
              renameCancelledRef.current = true
              setRenaming(false)
              setDraft(run.goal ?? '')
            }
          }}
          onBlur={commitRename}
        />
      </div>
    )
  }

  return (
    <div
      role="listitem"
      className={cn(
        'group relative min-w-0',
        active ? 'text-fg-strong' : 'text-fg/80'
      )}
    >
      <button
        type="button"
        className={cn(
          'app-region-no-drag flex w-full min-w-0 items-center gap-1 rounded-md py-1 pl-1.5 pr-12 text-left text-[13px] leading-snug vy-transition',
          active ? 'bg-surface' : 'hover:bg-surface/60 hover:text-fg'
        )}
        aria-current={active ? 'true' : undefined}
        title={runTooltip(run)}
        onClick={onSelect}
      >
        <RunStatusDot status={run.status} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span
          className={cn(
            'hidden shrink-0 text-[10px] text-muted tabular-nums @min-[12.5rem]/sidebar:inline group-hover:invisible [@media(hover:none)]:invisible',
            confirmingDelete && 'invisible'
          )}
        >
          {relativeTime(run.updatedAt)}
        </span>
      </button>

      <div
        className={cn(
          'app-region-no-drag absolute inset-y-1 right-1 z-10 flex items-center gap-0.5 vy-transition pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
          '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
          confirmingDelete && 'pointer-events-auto opacity-100'
        )}
      >
        {confirmingDelete ? (
          <InlineConfirmActions
            confirmLabel={`Confirm delete ${fullLabel}`}
            cancelLabel={`Cancel delete ${fullLabel}`}
            onConfirm={() => {
              setConfirmingDelete(false)
              onDelete()
            }}
            onCancel={() => setConfirmingDelete(false)}
          />
        ) : (
          <>
            <RowActionButton
              label={`Rename ${fullLabel}`}
              icon="edit"
              onClick={() => {
                setConfirmingDelete(false)
                setRenaming(true)
              }}
            />
            <RowActionButton
              label={`Delete ${fullLabel}`}
              icon="trash"
              className="hover:text-danger"
              onClick={() => setConfirmingDelete(true)}
            />
          </>
        )}
      </div>
    </div>
  )
})
