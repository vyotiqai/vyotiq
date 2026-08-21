/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TasksRailChip } from '@renderer/features/chat/components/TasksFloatingList'
import { ChatSideRail } from '@renderer/features/chat/components/ChatSideRail'

function todosPayload(
  todos: Array<{ id: string; content: string; status: string }>
) {
  return {
    ok: true as const,
    data: {
      name: 'todos.json',
      exists: true,
      content: JSON.stringify({
        updatedAt: '2026-01-01T00:00:00.000Z',
        todos
      })
    }
  }
}

describe('TasksRailChip', () => {
  const readRunArtifact = vi.fn()

  beforeEach(() => {
    readRunArtifact.mockReset()
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: { readRunArtifact }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders nothing when there are no tasks', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'todos.json', exists: false, content: null }
    })
    const onOpenPlan = vi.fn()
    const { container } = render(
      <TasksRailChip
        workspacePath="/ws"
        runId="run-1"
        running
        onOpenPlan={onOpenPlan}
      />
    )
    await waitFor(() => {
      expect(readRunArtifact).toHaveBeenCalled()
    })
    expect(container.querySelector('[data-tasks-floating]')).toBeNull()
  })

  it('renders a single count chip and opens Plan on click', async () => {
    readRunArtifact.mockResolvedValue(
      todosPayload([
        { id: '1', content: 'Map project', status: 'completed' },
        { id: '2', content: 'Run tests', status: 'in_progress' }
      ])
    )
    const onOpenPlan = vi.fn()
    render(
      <TasksRailChip
        workspacePath="/ws"
        runId="run-1"
        running
        onOpenPlan={onOpenPlan}
      />
    )
    await waitFor(() => {
      expect(screen.getByText('1/2')).toBeTruthy()
    })
    expect(document.querySelector('[data-tasks-floating-chip]')).toBeTruthy()
    expect(document.querySelectorAll('[data-tasks-floating-chip]')).toHaveLength(1)
    expect(screen.queryByText('Map project')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Tasks 1 of 2/ }))
    expect(onOpenPlan).toHaveBeenCalledTimes(1)
  })

  it('sits on the Plan row of the side rail', async () => {
    readRunArtifact.mockResolvedValue(
      todosPayload([{ id: '1', content: 'Ship', status: 'pending' }])
    )
    const onSelectPanel = vi.fn()
    render(
      <ChatSideRail
        activePanel={null}
        onSelectPanel={onSelectPanel}
        workspacePath="/ws"
        runId="run-1"
        running
      />
    )
    await waitFor(() => {
      expect(screen.getByText('0/1')).toBeTruthy()
    })
    const row = document.querySelector('[data-plan-rail-row]')
    expect(row?.querySelector('[data-tasks-floating-chip]')).toBeTruthy()
    expect(row?.querySelector('[data-tasks-floating-chip]')?.className).not.toMatch(
      /flex-col/
    )
  })
})
