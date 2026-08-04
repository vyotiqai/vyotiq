/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModePicker } from '@renderer/features/chat/components/composer/ModePicker'

afterEach(() => {
  cleanup()
})

describe('ModePicker', () => {
  it('renders Agent without truncate clipping on the short label', () => {
    render(<ModePicker mode="agent" onModeChange={vi.fn()} />)
    const button = screen.getByRole('button', { name: /Agent mode/i })
    expect(button.textContent).toBe('Agent')
    expect(button.className).not.toMatch(/\btruncate\b/)
    const label = button.querySelector('span')
    expect(label).toBeTruthy()
    expect(label!.className).not.toMatch(/\btruncate\b/)
    expect(label!.className).toMatch(/leading-tight/)
  })

  it('uses foreground color for Agent mode (not muted)', () => {
    render(<ModePicker mode="agent" onModeChange={vi.fn()} />)
    const button = screen.getByRole('button', { name: /Agent mode/i })
    expect(button.className).toMatch(/\btext-fg\b/)
    expect(button.className).not.toMatch(/\btext-muted\b/)
  })

  it('cycles to Ask on click', () => {
    const onModeChange = vi.fn()
    render(<ModePicker mode="agent" onModeChange={onModeChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent mode/i }))
    expect(onModeChange).toHaveBeenCalledWith('ask')
  })
})
