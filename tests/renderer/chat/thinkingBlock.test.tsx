/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ThinkingBlock } from '@renderer/features/chat/components/ThinkingBlock'

afterEach(() => {
  cleanup()
})

describe('ThinkingBlock', () => {
  it('keeps finished thought collapsed by default (minimal chrome)', () => {
    render(<ThinkingBlock content="Let me reason about this." />)
    const button = screen.getByRole('button', { name: /thought/i })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Let me reason about this.')).toBeNull()

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Let me reason about this.')).toBeTruthy()
  })

  it('opens while streaming so live reasoning is visible', () => {
    render(<ThinkingBlock content="Let me reason about this." streaming />)
    const button = screen.getByRole('button', { name: /thinking/i })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Let me reason about this.')).toBeTruthy()
  })

  it('lets the reader close the reasoning mid-stream', async () => {
    render(<ThinkingBlock content="Let me reason about this." streaming />)
    fireEvent.click(screen.getByRole('button', { name: /thinking/i }))
    await waitFor(() => {
      expect(screen.queryByText('Let me reason about this.')).toBeNull()
    })
  })

  it('honours an explicit expanded state over the stream', () => {
    render(<ThinkingBlock content="Let me reason about this." streaming expanded={false} />)
    expect(screen.queryByText('Let me reason about this.')).toBeNull()
  })

  it('does not render placeholder-only reasoning', () => {
    const { container } = render(<ThinkingBlock content="." />)
    expect(container.firstChild).toBeNull()
  })

  it('does not render short finished reasoning stubs', () => {
    const { container } = render(<ThinkingBlock content="OK" />)
    expect(container.firstChild).toBeNull()
  })

  it('still shows short reasoning while it streams', () => {
    render(<ThinkingBlock content="OK" streaming />)
    expect(screen.getByRole('button', { name: /thinking/i })).toBeTruthy()
  })

  it('caps open reasoning in a scrollable body so it cannot flood the timeline', () => {
    const long = 'Plan step. '.repeat(80)
    const { container } = render(<ThinkingBlock content={long} streaming />)
    const body = container.querySelector('.overflow-y-auto')
    expect(body).toBeTruthy()
    expect(body?.className).toMatch(/max-h-\[min\(/)
  })

  it('forces muted ink on markdown so reasoning does not use bright text-fg', () => {
    const { container } = render(<ThinkingBlock content="Let me reason about this." streaming />)
    const md = container.querySelector('.markdown-body')
    expect(md?.className).toMatch(/text-tertiary/)
  })
})
