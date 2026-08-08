/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { ChatPaneHost } from '@renderer/features/chat/ChatPaneHost'
import {
  markSessionDragEnd,
  markSessionDragStart,
  SESSION_DRAG_MIME
} from '@renderer/lib/chat/chatPaneLayout'
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
  it('keeps multi-pane headers visible with titles and min width shells', () => {
    const panes: ChatPane[] = [
      pane,
      { paneId: 'pane-2', workspacePath: '/ws/a', runId: null }
    ]
    render(
      <ChatPaneHost
        panes={panes}
        focusedPaneId="pane-1"
        sizes={[0.5, 0.5]}
        sideRailPad
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={() => true}
        getPaneTitle={(p) => (p.runId ? 'Chat A' : 'New chat')}
        renderPane={(_p, opts) => (
          <div data-testid="pane-body" data-rail={opts.sideRailPad ? '1' : '0'}>
            body
          </div>
        )}
      />
    )

    const headers = screen.getAllByRole('button', { name: /Close /i })
    expect(headers).toHaveLength(2)
    expect(screen.getByText('Chat A')).toBeTruthy()
    expect(screen.getByText('New chat')).toBeTruthy()
    expect(document.querySelectorAll('[data-chat-pane-header]')).toHaveLength(2)

    const shells = document.querySelectorAll('[data-chat-pane-shell]')
    expect(shells).toHaveLength(2)
    for (const shell of shells) {
      expect((shell as HTMLElement).style.minWidth).toBe('360px')
    }

    const bodies = screen.getAllByTestId('pane-body')
    expect(bodies[0]!.getAttribute('data-rail')).toBe('0')
    expect(bodies[1]!.getAttribute('data-rail')).toBe('1')
  })

  it('splits on left-third drop', () => {
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
    dropAt(host, 80, JSON.stringify({ workspacePath: '/ws/b', runId: 'run-b' }))

    expect(onSessionDrop).toHaveBeenCalledWith('pane-1', 'left', {
      workspacePath: '/ws/b',
      runId: 'run-b'
    })
  })

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

  it('accepts dragover with text/plain while a session drag is active', () => {
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
    markSessionDragStart()
    const dragOver = createEvent.dragOver(host, {
      dataTransfer: { types: ['text/plain'] }
    })
    Object.defineProperty(dragOver, 'clientX', { configurable: true, value: 520 })
    fireEvent(host, dragOver)
    markSessionDragEnd()

    const drop = createEvent.drop(host, {
      dataTransfer: {
        types: ['text/plain'],
        getData: (type: string) =>
          type === 'text/plain'
            ? JSON.stringify({ workspacePath: '/ws/b', runId: 'run-b' })
            : ''
      }
    })
    Object.defineProperty(drop, 'clientX', { configurable: true, value: 520 })
    fireEvent(host, drop)

    expect(onSessionDrop).toHaveBeenCalledWith('pane-1', 'right', {
      workspacePath: '/ws/b',
      runId: 'run-b'
    })
  })
})
