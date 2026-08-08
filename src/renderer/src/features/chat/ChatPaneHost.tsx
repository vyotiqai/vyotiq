import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatPane, PaneDropZone } from '@renderer/lib/chat/chatPaneLayout'
import {
  isSessionDragEvent,
  parseSessionDragPayload,
  resolvePaneDropZone
} from '@renderer/lib/chat/chatPaneLayout'
import { CHAT_COLUMN_MIN_USABLE_PX } from '@renderer/lib/utils/layout'
import { PanelResizeHandle } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/ui/cn'

type DropHighlight = {
  paneId: string
  zone: PaneDropZone
} | null

function zoneFromEvent(e: React.DragEvent): PaneDropZone {
  const el =
    (e.currentTarget as HTMLElement | null) ??
    ((e.target as HTMLElement | null)?.closest?.('[data-chat-pane]') as HTMLElement | null)
  if (!el) return 'right'
  const rect = el.getBoundingClientRect()
  const clientX =
    typeof e.clientX === 'number' && Number.isFinite(e.clientX)
      ? e.clientX
      : (e.nativeEvent as DragEvent | undefined)?.clientX
  if (typeof clientX !== 'number' || !Number.isFinite(clientX)) return 'right'
  return resolvePaneDropZone(clientX - rect.left, rect.width)
}

export function ChatPaneHost({
  panes,
  focusedPaneId,
  sizes,
  onFocusPane,
  onClosePane,
  onSizesChange,
  onSessionDrop,
  getPaneTitle,
  renderPane
}: {
  panes: ChatPane[]
  focusedPaneId: string
  sizes: number[]
  onFocusPane: (paneId: string) => void
  onClosePane: (paneId: string) => void
  onSizesChange: (sizes: number[]) => void
  onSessionDrop: (anchorPaneId: string, zone: PaneDropZone, payload: {
    workspacePath: string
    runId: string
  }) => boolean
  getPaneTitle: (pane: ChatPane) => string
  renderPane: (pane: ChatPane, focused: boolean) => ReactNode
}) {
  const [dropHighlight, setDropHighlight] = useState<DropHighlight>(null)
  const dropHighlightRef = useRef<DropHighlight>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const [rowWidth, setRowWidth] = useState(0)

  useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? row.clientWidth
      if (width > 0) setRowWidth(width)
    })
    observer.observe(row)
    setRowWidth(row.clientWidth)
    return () => observer.disconnect()
  }, [])

  const setHighlight = useCallback((next: DropHighlight) => {
    const prev = dropHighlightRef.current
    if (prev?.paneId === next?.paneId && prev?.zone === next?.zone) return
    dropHighlightRef.current = next
    setDropHighlight(next)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, paneId: string) => {
    if (!isSessionDragEvent(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setHighlight({ paneId, zone: zoneFromEvent(e) })
  }, [setHighlight])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setHighlight(null)
  }, [setHighlight])

  const handleDrop = useCallback(
    (e: React.DragEvent, paneId: string) => {
      e.preventDefault()
      const payload = parseSessionDragPayload(e.dataTransfer)
      const zone = zoneFromEvent(e)
      setHighlight(null)
      if (!payload) return
      onSessionDrop(paneId, zone, payload)
    },
    [onSessionDrop, setHighlight]
  )

  const resizePane = useCallback(
    (index: number, nextPx: number) => {
      const total = rowWidth || rowRef.current?.clientWidth || 0
      if (total <= 0 || panes.length < 2) return
      const pairSum = (sizes[index] ?? 0) + (sizes[index + 1] ?? 0)
      if (pairSum <= 0) return
      const minWeight = Math.min(pairSum / 2, CHAT_COLUMN_MIN_USABLE_PX / total)
      const left = Math.min(Math.max(nextPx / total, minWeight), pairSum - minWeight)
      const nextSizes = [...sizes]
      nextSizes[index] = left
      nextSizes[index + 1] = pairSum - left
      onSizesChange(nextSizes)
    },
    [onSizesChange, panes.length, rowWidth, sizes]
  )

  const minPanePx = CHAT_COLUMN_MIN_USABLE_PX

  return (
    <div
      ref={rowRef}
      className="flex min-h-0 min-w-0 flex-1 overflow-x-auto"
      data-chat-pane-host
    >
      {panes.map((pane, index) => {
        const focused = pane.paneId === focusedPaneId
        const flexGrow = sizes[index] ?? 1
        const highlight =
          dropHighlight?.paneId === pane.paneId ? dropHighlight.zone : null
        const paneTitle = getPaneTitle(pane)
        const pairSum =
          index < panes.length - 1
            ? (sizes[index] ?? 0) + (sizes[index + 1] ?? 0)
            : 0
        return (
          <div
            key={pane.paneId}
            className="flex min-h-0 min-w-0"
            style={{ flex: `${flexGrow} 1 0`, minWidth: minPanePx }}
          >
            <div
              role="region"
              aria-label={paneTitle}
              className={cn(
                'group/pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
                focused ? 'bg-bg' : 'bg-bg/95',
                index > 0 && 'border-l border-border/50'
              )}
              data-chat-pane
              data-chat-pane-focused={focused ? '1' : '0'}
              onPointerDownCapture={() => onFocusPane(pane.paneId)}
              onDragOverCapture={(e) => handleDragOver(e, pane.paneId)}
              onDragLeave={handleDragLeave}
              onDropCapture={(e) => handleDrop(e, pane.paneId)}
            >
              {highlight ? (
                <div
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute inset-y-0 z-30 bg-fg/8 ring-1 ring-inset ring-border-strong/70',
                    highlight === 'left' && 'left-0 w-1/3',
                    highlight === 'right' && 'right-0 w-1/3',
                    highlight === 'center' && 'left-1/3 w-1/3'
                  )}
                />
              ) : null}
              {panes.length > 1 ? (
                <div
                  className={cn(
                    'absolute inset-x-0 top-0 z-20 flex h-7 items-center justify-between gap-2 px-2',
                    index === panes.length - 1 && 'pr-10',
                    'opacity-0 vy-transition group-hover/pane:opacity-100 group-focus-within/pane:opacity-100',
                    focused && 'opacity-100',
                    '[@media(hover:none)]:opacity-100'
                  )}
                >
                  <span className="min-w-0 truncate text-xs text-muted">{paneTitle}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted vy-transition hover:bg-surface/70 hover:text-fg"
                    aria-label={`Close ${paneTitle}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClosePane(pane.paneId)
                    }}
                  >
                    Close
                  </button>
                </div>
              ) : null}
              <div
                className={cn(
                  'flex min-h-0 min-w-0 flex-1 flex-col',
                  panes.length > 1 && 'pt-7'
                )}
              >
                {renderPane(pane, focused)}
              </div>
            </div>
            {index < panes.length - 1 ? (
              <PanelResizeHandle
                label="Resize chat panes"
                value={Math.round(rowWidth * (sizes[index] ?? 0))}
                min={minPanePx}
                max={Math.max(
                  minPanePx * 2,
                  Math.round(rowWidth * pairSum - minPanePx)
                )}
                edge="end"
                onChange={(next) => resizePane(index, next)}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
