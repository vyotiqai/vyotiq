/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatStartWork } from '@renderer/features/chat/components/ChatStartWork'
import {
  formatStartWorkDraft,
  formatStartWorkLabel
} from '@renderer/features/chat/utils/chatStartWork'

afterEach(() => {
  cleanup()
})

describe('formatStartWorkLabel', () => {
  it('omits a label when the working tree is clean', () => {
    expect(formatStartWorkLabel([{ path: 'src/loop.ts' }], 0)).toBeNull()
    expect(formatStartWorkLabel([], 0)).toBeNull()
  })

  it('names real paths and caps the remainder', () => {
    expect(formatStartWorkLabel([{ path: 'src/loop.ts' }], 1)).toBe('Review src/loop.ts')
    expect(
      formatStartWorkLabel([{ path: 'src/loop.ts' }, { path: 'src/ChatView.tsx' }], 2)
    ).toBe('Review src/loop.ts, src/ChatView.tsx')
    expect(
      formatStartWorkLabel(
        [
          { path: 'src/loop.ts' },
          { path: 'src/ChatView.tsx' },
          { path: 'src/App.tsx' },
          { path: 'a.ts' },
          { path: 'b.ts' },
          { path: 'c.ts' }
        ],
        6
      )
    ).toBe('Review src/loop.ts, src/ChatView.tsx, +4')
  })
})

describe('formatStartWorkDraft', () => {
  it('omits a draft when fileCount is 0', () => {
    expect(formatStartWorkDraft([{ path: 'src/loop.ts' }], 0)).toBeNull()
  })

  it('writes a task with the same real paths as the label', () => {
    expect(
      formatStartWorkDraft(
        [{ path: 'src/loop.ts' }, { path: 'src/ChatView.tsx' }, { path: 'src/App.tsx' }],
        6
      )
    ).toBe('Review src/loop.ts, src/ChatView.tsx, +4.')
  })
})

describe('ChatStartWork', () => {
  it('fills the composer on click and does not expose a Changes action', () => {
    const onFill = vi.fn()
    render(<ChatStartWork label="Review src/loop.ts, src/ChatView.tsx, +4" onFill={onFill} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review src/loop.ts, src/ChatView.tsx, +4' }))
    expect(onFill).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /changes/i })).toBeNull()
  })
})
