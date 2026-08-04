import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { cn } from './cn'

export type PanelResizeHandleProps = {
  /** Accessible name for the separator. */
  label: string
  /** Current size in px (for ARIA). */
  value: number
  min: number
  max: number
  /**
   * How pointer delta maps to size:
   * - `start`: handle on the leading edge of the panel (e.g. dock left) — move left grows
   * - `end`: handle on the trailing edge (e.g. sidebar right) — move right grows
   */
  edge: 'start' | 'end'
  onChange: (next: number) => void
  /** Optional step for Arrow keys (default 8). Shift multiplies by 5. */
  step?: number
  className?: string
  disabled?: boolean
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Vertical drag gutter between side-by-side panes.
 * Mouse drag + ARIA separator; keyboard arrows nudge width.
 */
export function PanelResizeHandle({
  label,
  value,
  min,
  max,
  edge,
  onChange,
  step = 8,
  className,
  disabled = false
}: PanelResizeHandleProps) {
  const [dragging, setDragging] = useState(false)
  const valueRef = useRef(value)
  valueRef.current = value
  const edgeRef = useRef(edge)
  edgeRef.current = edge
  const minRef = useRef(min)
  minRef.current = min
  const maxRef = useRef(max)
  maxRef.current = max
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const apply = useCallback((next: number) => {
    onChangeRef.current(clamp(next, minRef.current, maxRef.current))
  }, [])

  const onMouseDown = (e: MouseEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return
    e.preventDefault()

    const startX = e.clientX
    const startValue = valueRef.current
    setDragging(true)

    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const onMove = (ev: globalThis.MouseEvent): void => {
      const dx = ev.clientX - startX
      const delta = edgeRef.current === 'end' ? dx : -dx
      apply(startValue + delta)
    }

    const onUp = (): void => {
      setDragging(false)
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const mul = e.shiftKey ? 5 : 1
    const amount = step * mul
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      apply(value + (edge === 'end' ? -amount : amount))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      apply(value + (edge === 'end' ? amount : -amount))
    } else if (e.key === 'Home') {
      e.preventDefault()
      apply(min)
    } else if (e.key === 'End') {
      e.preventDefault()
      apply(max)
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-panel-resize-handle
      data-dragging={dragging ? '1' : undefined}
      className={cn(
        'group relative z-sticky w-1.5 shrink-0 touch-none select-none',
        disabled
          ? 'cursor-default'
          : 'cursor-col-resize focus-visible:vy-focus-ring',
        className
      )}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent',
          'group-hover:bg-border group-focus-visible:bg-accent',
          dragging && 'bg-accent'
        )}
      />
    </div>
  )
}
