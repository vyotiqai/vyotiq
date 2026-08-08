import { memo, useEffect, useRef, useState } from 'react'
import { IconButton, cn } from '@renderer/lib/ui'
import {
  SIDEBAR_ROW,
  SIDEBAR_ROW_FOCUSED,
  SIDEBAR_ROW_HOVER,
  SIDEBAR_ROW_OPEN
} from '@renderer/lib/utils/layout'
import type { RunSummary } from '@shared/ipc'
import {
  markSessionDragEnd,
  markSessionDragStart,
  writeSessionDragPayload
} from '@renderer/lib/chat/chatPaneLayout'
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
      <span className="size-1.5 shrink-0 rounded-full bg-danger" title="Run ended with errors">
        <span className="sr-only">Run ended with errors</span>
      </span>
    )
  }
  return null
}

export const ChatRow = memo(function ChatRow({
  run,
  workspacePath,
  active,
  focused,
  onSelect,
  onRename,
  onDelete
}: {
  run: RunSummary
  workspacePath: string
  active: boolean
  focused?: boolean
  onSelect: () => void
  onRename: (goal: string) => void
  onDelete: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [dragging, setDragging] = useState(false)
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
      <div role="listitem" className="px-1.5 py-0.5">
        <input
          ref={inputRef}
          type="text"
          className="app-region-no-drag w-full rounded-lg border border-border/50 bg-surface/60 px-2 py-1.5 text-sm text-fg outline-none focus:border-border-strong focus:bg-surface focus:vy-focus-ring"
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
      className={cn('group relative min-w-0', active ? 'text-fg-strong' : '')}
    >
      <button
        type="button"
        draggable={!renaming && !confirmingDelete}
        className={cn(
          'app-region-no-drag flex w-full min-w-0 items-center gap-1.5 pr-2 text-left vy-transition',
          'group-hover:pr-10 group-focus-within:pr-10 [@media(hover:none)]:pr-10',
          SIDEBAR_ROW,
          active
            ? focused
              ? SIDEBAR_ROW_FOCUSED
              : SIDEBAR_ROW_OPEN
            : SIDEBAR_ROW_HOVER,
          !active && 'text-fg/85',
          dragging && 'opacity-50'
        )}
        aria-current={focused ? 'page' : undefined}
        data-session-open={active ? '1' : '0'}
        data-session-focused={focused ? '1' : '0'}
        title={runTooltip(run)}
        onClick={onSelect}
        onDragStart={(e) => {
          if (renaming || confirmingDelete) {
            e.preventDefault()
            return
          }
          writeSessionDragPayload(e.dataTransfer, {
            workspacePath,
            runId: run.runId
          })
          markSessionDragStart()
          setDragging(true)
        }}
        onDragEnd={() => {
          markSessionDragEnd()
          setDragging(false)
        }}
      >
        <RunStatusDot status={run.status} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>

      <div
        className={cn(
          'app-region-no-drag absolute inset-y-0 right-0 z-10 flex items-center gap-px vy-transition pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
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
            <IconButton
              icon="edit"
              label={`Rename ${fullLabel}`}
              size="xs"
              variant="bare"
              className="text-muted hover:text-fg"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                setConfirmingDelete(false)
                setRenaming(true)
              }}
            />
            <IconButton
              icon="trash"
              label={`Delete ${fullLabel}`}
              size="xs"
              variant="bare"
              className="text-muted hover:text-danger"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                setConfirmingDelete(true)
              }}
            />
          </>
        )}
      </div>
    </div>
  )
})
