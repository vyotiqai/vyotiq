/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRunTodos } from '@renderer/features/chat/hooks/useRunTodos'

describe('useRunTodos poll cadence', () => {
  const readRunArtifact = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    readRunArtifact.mockReset()
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: { readRunArtifact }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses 2s polls while running before todos exist', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'todos.json', exists: false, content: null }
    })
    renderHook(() =>
      useRunTodos({ workspacePath: '/ws', runId: 'run-1', running: true, active: true })
    )
    await act(async () => {
      await Promise.resolve()
    })
    const afterMount = readRunArtifact.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(readRunArtifact.mock.calls.length).toBe(afterMount)
    await act(async () => {
      vi.advanceTimersByTime(1500)
      await Promise.resolve()
    })
    expect(readRunArtifact.mock.calls.length).toBeGreaterThan(afterMount)
  })

  it('uses 500ms polls while running once todos are visible', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: {
        name: 'todos.json',
        exists: true,
        content: JSON.stringify({
          todos: [{ id: '1', content: 'Ship', status: 'in_progress' }]
        })
      }
    })
    renderHook(() =>
      useRunTodos({ workspacePath: '/ws', runId: 'run-1', running: true, active: true })
    )
    await act(async () => {
      await Promise.resolve()
    })
    const afterMount = readRunArtifact.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(readRunArtifact.mock.calls.length).toBeGreaterThan(afterMount)
  })

  it('does not poll when inactive', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'todos.json', exists: false, content: null }
    })
    renderHook(() =>
      useRunTodos({ workspacePath: '/ws', runId: 'run-1', running: true, active: false })
    )
    await act(async () => {
      await Promise.resolve()
    })
    const afterMount = readRunArtifact.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(4000)
      await Promise.resolve()
    })
    expect(readRunArtifact.mock.calls.length).toBe(afterMount)
  })
})
