/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToastHost } from '@renderer/lib/ui/ToastHost'
import { getToasts, pushToast, resetToastStoreForTests } from '@renderer/lib/ui/toastStore'

beforeEach(() => {
  vi.useFakeTimers()
  resetToastStoreForTests()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetToastStoreForTests()
})

describe('ToastHost', () => {
  it('runs onClick from the toast body and not from dismiss', () => {
    const onClick = vi.fn()
    pushToast('Finished: Fix tests', 'info', 0, onClick)
    render(<ToastHost />)
    fireEvent.click(screen.getByRole('button', { name: 'Finished: Fix tests' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    fireEvent.animationEnd(screen.getByRole('status'), { animationName: 'vy-toast-out' })
    expect(screen.queryByText('Finished: Fix tests')).toBeNull()
  })

  it('dismiss does not run onClick', () => {
    const onClick = vi.fn()
    pushToast('Agent finished', 'info', 0, onClick)
    render(<ToastHost />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(onClick).not.toHaveBeenCalled()
    fireEvent.animationEnd(screen.getByRole('status'), { animationName: 'vy-toast-out' })
    expect(screen.queryByText('Agent finished')).toBeNull()
  })

  it('pauses auto-dismiss while hovered', () => {
    vi.setSystemTime(0)
    pushToast('hover me', 'info', 100)
    render(<ToastHost />)
    const toast = screen.getByText('hover me').closest('[role="status"]') as HTMLElement
    fireEvent.pointerEnter(toast)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0]?.expiresAt).toBeNull()
    fireEvent.pointerLeave(toast)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(getToasts()).toHaveLength(0)
  })
})
