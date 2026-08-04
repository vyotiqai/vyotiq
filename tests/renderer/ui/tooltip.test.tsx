/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { IconButton } from '@renderer/lib/ui/IconButton'
import { Tooltip } from '@renderer/lib/ui/Tooltip'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers()
})

function tip(): HTMLElement | null {
  return document.body.querySelector('[role="tooltip"]')
}

describe('Tooltip', () => {
  it('shows content after hover delay', () => {
    render(
      <Tooltip content="Hint text" delayMs={400}>
        <button type="button">Trigger</button>
      </Tooltip>
    )

    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Trigger' }))
    expect(tip()).toBeNull()

    act(() => {
      vi.advanceTimersByTime(400)
    })

    expect(tip()?.textContent).toBe('Hint text')
    expect(tip()?.getAttribute('data-opened-by')).toBe('hover')
  })

  it('cancels pending show when Escape is pressed during delay', () => {
    render(
      <Tooltip content="Delayed" delayMs={400}>
        <button type="button">Trigger</button>
      </Tooltip>
    )

    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Trigger' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(tip()).toBeNull()
  })

  it('shows content on focus and hides on Escape', () => {
    render(
      <Tooltip content="Focus tip" delayMs={100}>
        <button type="button">Focus me</button>
      </Tooltip>
    )

    const button = screen.getByRole('button', { name: 'Focus me' })
    fireEvent.focus(button)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(tip()?.textContent).toBe('Focus tip')
    expect(tip()?.getAttribute('data-opened-by')).toBe('focus')
    expect(button.getAttribute('aria-describedby')).toBeTruthy()

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(tip()).toBeNull()
  })

  it('hides hover tip on Escape without claiming the event', () => {
    render(
      <Tooltip content="Hover tip" delayMs={50}>
        <button type="button">Hover</button>
      </Tooltip>
    )

    const button = screen.getByRole('button', { name: 'Hover' })
    fireEvent.pointerEnter(button)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(tip()).not.toBeNull()

    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    act(() => {
      window.dispatchEvent(esc)
    })
    expect(esc.defaultPrevented).toBe(false)
    expect(tip()).toBeNull()
  })

  it('hides on pointer leave', () => {
    render(
      <Tooltip content="Leave tip" delayMs={50}>
        <button type="button">Leave</button>
      </Tooltip>
    )

    const button = screen.getByRole('button', { name: 'Leave' })
    fireEvent.pointerEnter(button)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(tip()).not.toBeNull()

    fireEvent.pointerLeave(button)
    expect(tip()).toBeNull()
  })

  it('hides on scroll', () => {
    render(
      <Tooltip content="Scroll tip" delayMs={50}>
        <button type="button">Scroll</button>
      </Tooltip>
    )

    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Scroll' }))
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(tip()).not.toBeNull()

    fireEvent.scroll(window)
    expect(tip()).toBeNull()
  })
})

describe('IconButton tooltip', () => {
  it('shows label as tooltip text on hover', () => {
    render(<IconButton icon="gear" label="Settings" />)

    const button = screen.getByRole('button', { name: 'Settings' })
    expect(button.getAttribute('title')).toBeNull()
    expect(button.getAttribute('aria-label')).toBe('Settings')

    fireEvent.pointerEnter(button)
    act(() => {
      vi.advanceTimersByTime(400)
    })

    expect(tip()?.textContent).toBe('Settings')
  })

  it('shows why-disabled tip via wrapper when disabled', () => {
    render(
      <IconButton icon="plus" label="New chat" title="Open a workspace first" disabled />
    )

    const button = screen.getByRole('button', { name: 'New chat' })
    expect(button.hasAttribute('disabled')).toBe(true)

    const wrap = button.parentElement
    expect(wrap).toBeTruthy()
    fireEvent.pointerEnter(wrap!)
    act(() => {
      vi.advanceTimersByTime(400)
    })

    expect(tip()?.textContent).toBe('Open a workspace first')
  })
})
