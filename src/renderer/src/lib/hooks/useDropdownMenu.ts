import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from 'react'

const DROPDOWN_GAP_PX = 6
const VIEWPORT_PAD_PX = 8
/** Fallback when the panel has not measured yet. */
const DEFAULT_MENU_HEIGHT_PX = 120

export type DropdownPlacement = 'up' | 'down'
export type DropdownAlign = 'start' | 'end'

export type DropdownPosition = {
  top: number
  left: number
  width: number
  minWidth: number
  /** Preferred placement after viewport collision flip. */
  placement: DropdownPlacement
}

export function useDropdownMenu({
  open,
  onOpenChange,
  triggerRef,
  panelRef,
  placement = 'up',
  align = 'start',
  disabled
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  triggerRef: RefObject<HTMLElement | null>
  panelRef?: RefObject<HTMLElement | null>
  placement?: DropdownPlacement
  align?: DropdownAlign
  disabled?: boolean
}): {
  position: DropdownPosition | null
  close: (restoreFocus?: boolean) => void
} {
  const [position, setPosition] = useState<DropdownPosition | null>(null)
  const preferredPlacement = useRef(placement)
  preferredPlacement.current = placement

  const close = useCallback(
    (restoreFocus = false) => {
      onOpenChange(false)
      if (restoreFocus) {
        window.setTimeout(() => triggerRef.current?.focus(), 0)
      }
    },
    [onOpenChange, triggerRef]
  )

  const updatePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const panelH = panelRef?.current?.offsetHeight || DEFAULT_MENU_HEIGHT_PX
    let resolved = preferredPlacement.current

    if (resolved === 'down') {
      if (rect.bottom + DROPDOWN_GAP_PX + panelH > window.innerHeight - VIEWPORT_PAD_PX) {
        resolved = 'up'
      }
    } else if (rect.top - DROPDOWN_GAP_PX - panelH < VIEWPORT_PAD_PX) {
      resolved = 'down'
    }

    setPosition({
      top: resolved === 'up' ? rect.top - DROPDOWN_GAP_PX : rect.bottom + DROPDOWN_GAP_PX,
      left: align === 'end' ? rect.right : rect.left,
      width: Math.min(300, window.innerWidth - 32),
      minWidth: Math.max(rect.width, 188),
      placement: resolved
    })
  }, [triggerRef, panelRef, align])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    updatePosition()
    // Remeasure after the panel paints so flip uses real height.
    const raf = window.requestAnimationFrame(() => updatePosition())
    const onLayout = (): void => updatePosition()
    window.addEventListener('resize', onLayout)
    window.addEventListener('scroll', onLayout, true)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', onLayout)
      window.removeEventListener('scroll', onLayout, true)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (disabled && open) close(false)
  }, [disabled, open, close])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (panelRef?.current?.contains(target)) return
      close(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close(true)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close, triggerRef, panelRef])

  return { position, close }
}

export { DROPDOWN_GAP_PX }
