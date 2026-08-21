import {
  Children,
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type Ref
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'

type Side = 'top' | 'bottom'
type OpenedBy = 'hover' | 'focus'

function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (!ref) return
  if (typeof ref === 'function') ref(node)
  else ref.current = node
}

const VIEWPORT_PAD = 8

function placeCoords(
  rect: DOMRect,
  preferred: Side
): { top: number; left: number; side: Side } {
  const spaceAbove = rect.top
  const spaceBelow = window.innerHeight - rect.bottom
  let side = preferred
  if (preferred === 'top' && spaceAbove < 40 && spaceBelow > spaceAbove) side = 'bottom'
  if (preferred === 'bottom' && spaceBelow < 40 && spaceAbove > spaceBelow) side = 'top'

  let left = rect.left + rect.width / 2
  left = Math.min(window.innerWidth - VIEWPORT_PAD, Math.max(VIEWPORT_PAD, left))

  return {
    side,
    top: side === 'top' ? rect.top : rect.bottom,
    left
  }
}

export function Tooltip({
  content,
  children,
  delayMs = 400,
  side = 'top',
  describeChild = true
}: {
  content: string
  children: ReactElement
  delayMs?: number
  side?: Side
  /** Disable the tooltip's accessible description when the child already names itself. */
  describeChild?: boolean
}) {
  const tooltipId = useId()
  const [open, setOpen] = useState(false)
  const [openedBy, setOpenedBy] = useState<OpenedBy | null>(null)
  const [coords, setCoords] = useState<{ top: number; left: number; side: Side } | null>(
    null
  )
  const triggerRef = useRef<HTMLElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const openedByRef = useRef<OpenedBy | null>(null)
  const preferredSideRef = useRef(side)
  preferredSideRef.current = side

  const clearTimer = (): void => {
    if (timerRef.current == null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const hide = useCallback((): void => {
    clearTimer()
    openedByRef.current = null
    setOpenedBy(null)
    setOpen(false)
  }, [])

  const show = (via: OpenedBy): void => {
    if (!content) return
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      const el = triggerRef.current
      if (!el) return
      const placed = placeCoords(el.getBoundingClientRect(), preferredSideRef.current)
      openedByRef.current = via
      setOpenedBy(via)
      setCoords(placed)
      setOpen(true)
    }, delayMs)
  }

  useEffect(() => () => clearTimer(), [])

  // Cancel pending show even before the tip mounts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (timerRef.current == null) return
      clearTimer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Dismiss open tip — focus-opened claims Esc; hover tips hide quietly
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (openedByRef.current === 'focus') {
        e.preventDefault()
      }
      hide()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, hide])

  useEffect(() => {
    if (!open) return
    const onReposition = (): void => {
      hide()
    }
    window.addEventListener('scroll', onReposition, true)
    window.addEventListener('resize', onReposition)
    return () => {
      window.removeEventListener('scroll', onReposition, true)
      window.removeEventListener('resize', onReposition)
    }
  }, [open, hide])

  const child = Children.only(children) as ReactElement<{
    ref?: Ref<HTMLElement>
    'aria-describedby'?: string
    onPointerEnter?: (e: PointerEvent) => void
    onPointerLeave?: (e: PointerEvent) => void
    onFocus?: (e: FocusEvent) => void
    onBlur?: (e: FocusEvent) => void
  }>

  const describedBy = [child.props['aria-describedby'], describeChild && open ? tooltipId : null]
    .filter(Boolean)
    .join(' ')

  const trigger = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      assignRef(child.props.ref, node)
    },
    'aria-describedby': describedBy || undefined,
    onPointerEnter: (e: PointerEvent) => {
      show('hover')
      child.props.onPointerEnter?.(e)
    },
    onPointerLeave: (e: PointerEvent) => {
      hide()
      child.props.onPointerLeave?.(e)
    },
    onFocus: (e: FocusEvent) => {
      show('focus')
      child.props.onFocus?.(e)
    },
    onBlur: (e: FocusEvent) => {
      hide()
      child.props.onBlur?.(e)
    }
  })

  const tipSide = coords?.side ?? side
  const style: CSSProperties | undefined = coords
    ? {
        top: tipSide === 'top' ? coords.top - 6 : coords.top + 6,
        left: coords.left
      }
    : undefined

  const tip =
    open && coords && content
      ? createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            data-opened-by={openedBy ?? undefined}
            className={cn(
              'pointer-events-none fixed z-tooltip max-w-xs -translate-x-1/2',
              tipSide === 'top' ? '-translate-y-full' : undefined
            )}
            style={style}
          >
            <div className="whitespace-pre-line rounded-md border border-border bg-card px-2 py-1 text-xs text-fg shadow-menu animate-tip-in">
              {content}
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <>
      {trigger}
      {tip}
    </>
  )
}
