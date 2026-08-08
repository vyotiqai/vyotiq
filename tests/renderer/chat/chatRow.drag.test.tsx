/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatRow } from '@renderer/app/sidebar/ChatRow'
import { SESSION_DRAG_MIME } from '@renderer/lib/chat/chatPaneLayout'
import type { RunSummary } from '@shared/ipc'

const run: RunSummary = {
  runId: 'run-1',
  goal: 'List files',
  status: 'idle',
  createdAt: Date.now(),
  updatedAt: Date.now()
}

describe('ChatRow drag', () => {
  it('sets session drag payload on dragstart', () => {
    render(
      <ChatRow
        run={run}
        workspacePath="/ws/home"
        active={false}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />
    )
    const row = screen.getByTitle('List files')
    const setData = vi.fn()
    fireEvent.dragStart(row, {
      dataTransfer: {
        types: [],
        setData,
        effectAllowed: 'copy'
      }
    })
    expect(setData).toHaveBeenCalledWith(
      SESSION_DRAG_MIME,
      JSON.stringify({ workspacePath: '/ws/home', runId: 'run-1' })
    )
    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      JSON.stringify({ workspacePath: '/ws/home', runId: 'run-1' })
    )
  })
})
