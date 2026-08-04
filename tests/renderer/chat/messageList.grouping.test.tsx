/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MessageList } from '@renderer/features/chat/components/MessageList'
import type { UiItem } from '@shared/transcript'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
})

function toolGroup(groupKey: string, summaries: string[]): UiItem[] {
  return summaries.map((summary, i) => ({
    kind: 'tool' as const,
    id: `${groupKey}-${i}`,
    tool: {
      id: `${groupKey}-${i}`,
      name: 'read',
      summary,
      status: 'done' as const
    },
    groupTiming: { startedAt: 1_000, endedAt: 2_000 }
  }))
}

describe('MessageList', () => {
  it('expands and collapses tool groups independently', async () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u-1', role: 'user', content: 'First task' },
      ...toolGroup('alpha', ['alpha-one.ts', 'alpha-two.ts']),
      { kind: 'message', id: 'u-2', role: 'user', content: 'Second task' },
      ...toolGroup('beta', ['beta-one.ts', 'beta-two.ts'])
    ]

    render(<MessageList items={items} />)

    const toggles = screen.getAllByRole('button', { name: /Read 2 files/i })
    expect(toggles).toHaveLength(2)
    for (const toggle of toggles) {
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
    }
    expect(screen.queryByText('alpha-one.ts')).toBeNull()
    expect(screen.queryByText('beta-one.ts')).toBeNull()

    fireEvent.click(toggles[0]!)

    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('false')
    const alphaGroup = toggles[0]!.parentElement as HTMLElement
    expect(within(alphaGroup).getByText('alpha-one.ts')).toBeTruthy()
    expect(within(alphaGroup).getByText('alpha-two.ts')).toBeTruthy()
    expect(screen.queryByText('beta-one.ts')).toBeNull()

    fireEvent.click(toggles[0]!)
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => {
      expect(screen.queryByText('alpha-one.ts')).toBeNull()
    })
  })

  it('does not reopen prior-turn tool groups when a follow-up run goes live', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u-1', role: 'user', content: 'First task' },
      ...toolGroup('alpha', ['alpha-one.ts', 'alpha-two.ts']),
      { kind: 'message', id: 'u-2', role: 'user', content: 'continue' }
    ]

    const { rerender } = render(<MessageList items={items} />)
    const prior = screen.getByRole('button', { name: /Read 2 files/i })
    expect(prior.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('alpha-one.ts')).toBeNull()

    rerender(<MessageList items={items} running />)
    expect(prior.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('alpha-one.ts')).toBeNull()

    const liveItems: UiItem[] = [
      ...items,
      {
        kind: 'tool',
        id: 'beta-0',
        tool: { id: 'beta-0', name: 'read', summary: 'beta-one.ts', status: 'running' },
        groupTiming: { startedAt: Date.now() }
      },
      {
        kind: 'tool',
        id: 'beta-1',
        tool: { id: 'beta-1', name: 'read', summary: 'beta-two.ts', status: 'running' }
      }
    ]
    rerender(<MessageList items={liveItems} running />)

    const toggles = screen.getAllByRole('button', { name: /Read(?:ing)? 2 files/i })
    expect(toggles).toHaveLength(2)
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText('alpha-one.ts')).toBeNull()
    expect(screen.getByText('beta-one.ts')).toBeTruthy()
  })

  it('does not render timestamps in the transcript', () => {
    const items: UiItem[] = [
      {
        kind: 'message',
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        at: '2026-07-24T15:30:00.000Z'
      }
    ]

    render(<MessageList items={items} />)

    expect(screen.queryByRole('time')).toBeNull()
  })
})
