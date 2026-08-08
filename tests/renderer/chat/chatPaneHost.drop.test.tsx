/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { ChatPaneHost } from '@renderer/features/chat/ChatPaneHost'
import { SESSION_DRAG_MIME } from '@renderer/lib/chat/chatPaneLayout'
import type { ChatPane } from '@renderer/lib/chat/chatPaneLayout'

const pane: ChatPane = {
  paneId: 'pane-1',
  workspacePath: '/ws/a',
  runId: 'run-a'
}

function mockPaneRect(host: HTMLElement): void {
  Object.defineProperty(host, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 400,
      right: 600,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
  })
}

function dropAt(host: HTMLElement, clientX: number, payload: string): void {
  const event = createEvent.drop(host, {
    dataTransfer: {
      types: [SESSION_DRAG_MIME],
      getData: (type: string) => (type === SESSION_DRAG_MIME ? payload : '')
    }
  })
  Object.defineProperty(event, 'clientX', { configurable: true, value: clientX })
  fireEvent(host, event)
}

describe('ChatPaneHost drop', () => {
  it('splits on right-third drop instead of replacing', () => {
    const onSessionDrop = vi.fn(() => true)
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={onSessionDrop}
        getPaneTitle={() => 'Chat A'}
        renderPane={() => <div data-testid="pane-body">body</div>}
      />
    )

    const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
    mockPaneRect(host)
    dropAt(host, 520, JSON.stringify({ workspacePath: '/ws/b', runId: 'run-b' }))

    expect(onSessionDrop).toHaveBeenCalledWith('pane-1', 'right', {
      workspacePath: '/ws/b',
      runId: 'run-b'
    })
  })

  it('replaces only on middle-third drop', () => {
    const onSessionDrop = vi.fn(() => true)
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={onSessionDrop}
        getPaneTitle={() => 'Chat A'}
        renderPane={() => <div data-testid="pane-body">body</div>}
      />
    )

    const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
    mockPaneRect(host)
    dropAt(host, 300, JSON.stringify({ workspacePath: '/ws/b', runId: 'run-b' }))

    expect(onSessionDrop).toHaveBeenCalledWith('pane-1', 'center', {
      workspacePath: '/ws/b',
      runId: 'run-b'
    })
  })
})
