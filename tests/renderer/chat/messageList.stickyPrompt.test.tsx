/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  excerptTurnPrompt,
  MessageList,
  stickyPromptTarget
} from '@renderer/features/chat/components/MessageList'
import { buildTranscriptRows } from '@renderer/features/chat/utils/transcriptRows'
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
  vi.restoreAllMocks()
})

function rect(top: number, bottom: number, height: number): DOMRect {
  return {
    top,
    bottom,
    height,
    width: 800,
    left: 0,
    right: 800,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

describe('excerptTurnPrompt', () => {
  it('collapses whitespace and keeps short prompts whole', () => {
    expect(excerptTurnPrompt('  fix   the\nlogin  bug  ')).toBe('fix the login bug')
  })

  it('truncates long prompts with an ellipsis', () => {
    const out = excerptTurnPrompt('a'.repeat(500))
    expect(out.length).toBeLessThanOrEqual(220)
    expect(out.endsWith('…')).toBe(true)
  })

  it('maps missing or blank content to an empty excerpt', () => {
    expect(excerptTurnPrompt(undefined)).toBe('')
    expect(excerptTurnPrompt('   ')).toBe('')
  })
})

describe('stickyPromptTarget', () => {
  const items: UiItem[] = [
    { kind: 'message', id: 'u1', role: 'user', content: 'first' },
    { kind: 'message', id: 'a1', role: 'assistant', content: 'reply' },
    { kind: 'message', id: 'u2', role: 'user', content: 'second' },
    { kind: 'message', id: 'a2', role: 'assistant', content: 'final' }
  ]
  const rows = buildTranscriptRows(items)

  it('targets the latest user row with its display index', () => {
    const target = stickyPromptTarget(rows, false, false)
    expect(target?.row.item.id).toBe('u2')
    expect(target?.index).toBe(
      rows.findIndex((row) => row.kind === 'user' && row.item.id === 'u2')
    )
  })

  it('is suppressed while a run is live', () => {
    expect(stickyPromptTarget(rows, true, false)).toBeNull()
    expect(stickyPromptTarget(rows, false, true)).toBeNull()
  })

  it('is null without user rows', () => {
    const assistantOnly = buildTranscriptRows([
      { kind: 'message', id: 'a1', role: 'assistant', content: 'hi' }
    ])
    expect(stickyPromptTarget(assistantOnly, false, false)).toBeNull()
  })
})

describe('MessageList sticky turn prompt', () => {
  const items: UiItem[] = [
    { kind: 'message', id: 'user-0', role: 'user', content: 'audit the router setup' },
    { kind: 'message', id: 'a1', role: 'assistant', content: 'Working on it.' }
  ]

  it('stays hidden on a short transcript at rest', () => {
    render(<MessageList items={items} />)
    expect(document.querySelector('[data-sticky-turn-prompt]')).toBeNull()

    fireEvent.scroll(document.querySelector('[data-transcript-scroll]') as HTMLDivElement)
    expect(document.querySelector('[data-sticky-turn-prompt]')).toBeNull()
  })

  it('never mounts while a run is live', () => {
    render(<MessageList items={items} running />)
    fireEvent.scroll(document.querySelector('[data-transcript-scroll]') as HTMLDivElement)
    expect(document.querySelector('[data-sticky-turn-prompt]')).toBeNull()
  })

  it('appears once the prompt row scrolls past the top edge, then scrolls back on click', () => {
    let promptAboveTop = false
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function getBoundingClientRect(this: Element): DOMRect {
        if (this.matches('[data-transcript-scroll]')) return rect(0, 800, 800)
        if (this.matches('[data-transcript-row="0"]')) {
          return promptAboveTop ? rect(-120, -20, 100) : rect(0, 100, 100)
        }
        return rect(0, 0, 0)
      }
    )
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    render(<MessageList items={items} />)
    // Prompt row still touches the top edge → no header.
    expect(document.querySelector('[data-sticky-turn-prompt]')).toBeNull()

    promptAboveTop = true
    fireEvent.scroll(document.querySelector('[data-transcript-scroll]') as HTMLDivElement)

    const header = document.querySelector('[data-sticky-turn-prompt]')
    expect(header).not.toBeNull()
    expect(header!.textContent).toContain('audit the router setup')

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to the prompt that started this section' }))
    expect(scrollIntoView).toHaveBeenCalled()
  })
})
