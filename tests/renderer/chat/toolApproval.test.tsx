/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function gatedItems(): UiItem[] {
  return [
    { kind: 'message', id: 'u1', role: 'user', content: 'Rename the file.' },
    {
      kind: 'tool',
      id: 'call-1',
      tool: { id: 'call-1', name: 'edit', summary: 'a.ts', status: 'running' },
      approval: {
        requestId: 'req-1',
        toolName: 'edit',
        summary: 'a.ts',
        argsPreview: '{"path":"a.ts"}',
        mutating: true
      }
    }
  ]
}

describe('tool approval card', () => {
  it('shows the gated call and what it would run', () => {
    const { container } = render(<MessageList items={gatedItems()} />)

    expect(screen.getByText('Editing')).toBeTruthy()
    expect(screen.getByTitle('edit')).toBeTruthy()
    expect(screen.getByText('mutating / network')).toBeTruthy()
    expect(screen.getByText('{"path":"a.ts"}')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Always allow' })).toBeTruthy()
    // Gate UI replaces the tool card — no parallel "Working…" chrome.
    expect(screen.queryByText('Working…')).toBeNull()
    // Match Ask Question gate surface (no extra full accent border).
    expect(container.querySelector('.border-l-accent')).toBeNull()
  })

  it('reports the reader decision once and locks the card', async () => {
    const onApprovalDecision = vi.fn()
    render(<MessageList items={gatedItems()} onApprovalDecision={onApprovalDecision} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow for session' }))
    await waitFor(() => {
      expect(onApprovalDecision).toHaveBeenCalledTimes(1)
    })
    expect(onApprovalDecision).toHaveBeenCalledWith('req-1', 'session')

    const deny = screen.getByRole('button', { name: 'Deny' })
    expect(deny.hasAttribute('disabled')).toBe(true)
    fireEvent.click(deny)
    expect(onApprovalDecision).toHaveBeenCalledTimes(1)
  })

  it('leaves the transcript alone when nothing is gated', () => {
    const items = gatedItems().map((item) =>
      item.kind === 'tool' ? { ...item, approval: undefined } : item
    )
    render(<MessageList items={items} />)

    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
  })

  it('does not lock the card when onApprovalDecision is missing', async () => {
    render(<MessageList items={gatedItems()} />)

    const allow = screen.getByRole('button', { name: 'Allow once' })
    expect(allow.hasAttribute('disabled')).toBe(true)
    fireEvent.click(allow)
    // Stay idle — no pending/done lock without a handler (mirrors AskQuestionPanel).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(true)
    })
    expect(screen.getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(true)
  })

  it('reports deny and recovers when onApprovalDecision rejects', async () => {
    const onApprovalDecision = vi.fn().mockRejectedValue(new Error('IPC offline'))
    render(<MessageList items={gatedItems()} onApprovalDecision={onApprovalDecision} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => {
      expect(onApprovalDecision).toHaveBeenCalledWith('req-1', 'deny')
    })
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('IPC offline')
    })
    expect(screen.getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(false)
  })
})
