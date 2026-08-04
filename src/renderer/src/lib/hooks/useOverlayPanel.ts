import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'

export function useOverlayPanel({
  open,
  onClose,
  panelRef,
  inertTargetRef,
  restoreFocusRef
}: {
  open: boolean
  onClose: () => void
  panelRef: RefObject<HTMLElement | null>
  inertTargetRef?: RefObject<HTMLElement | null>
  restoreFocusRef?: RefObject<HTMLElement | null>
}): void {
  const previousFocus = useRef<HTMLElement | null>(null)

  useEscapeToClose(onClose, open, { capture: true })

  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement as HTMLElement | null
    const target = inertTargetRef?.current
    if (target) target.setAttribute('inert', '')
    panelRef.current?.focus()

    return () => {
      if (target) target.removeAttribute('inert')
      const restore = restoreFocusRef?.current ?? previousFocus.current
      restore?.focus?.()
    }
  }, [open, inertTargetRef, panelRef, restoreFocusRef])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const panel = panelRef.current
      if (!panel) return
      if (panel.contains(event.target as Node)) return
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, onClose, panelRef])
}
