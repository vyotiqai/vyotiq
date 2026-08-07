/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'

async function flushStreamPatches(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

describe('createChatStreamController', () => {
  it('persists turn collapse across transcript remounts', () => {
    const controller = createChatStreamController({ workspacePath: '/ws' })

    expect(controller.collapsedTurnIndices).toEqual([])

    controller.toggleTurnCollapsed(0)
    expect(controller.collapsedTurnIndices).toEqual([0])

    controller.toggleTurnCollapsed(0)
    expect(controller.collapsedTurnIndices).toEqual([])

    controller.toggleTurnCollapsed(1)
    controller.toggleTurnCollapsed(2)
    expect(controller.collapsedTurnIndices).toEqual([1, 2])

    controller.reset()
    expect(controller.collapsedTurnIndices).toEqual([])
  })

  it('appends terminal_output_delta into a running terminal tool row', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })

    controller.handleEvent({
      type: 'tool_start',
      runId: 'r1',
      toolCallId: 'term-1',
      name: 'terminal',
      summary: 'echo hi'
    })
    controller.handleEvent({
      type: 'terminal_output_delta',
      runId: 'r1',
      toolCallId: 'term-1',
      text: 'hi\n',
      stream: 'stdout'
    })
    controller.handleEvent({
      type: 'terminal_output_delta',
      runId: 'r1',
      toolCallId: 'term-1',
      text: 'boom\n',
      stream: 'stderr'
    })
    await flushStreamPatches()

    const tool = controller.items.find((item) => item.kind === 'tool' && item.id === 'term-1')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind !== 'tool') return
    expect(tool.tool.status).toBe('running')
    expect(tool.tool.content).toBe('hi\n\nstderr:\nboom\n')
  })

  it('batches rapid text_delta events into one items revision per frame', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })

    const revisions: number[] = []
    const unsub = controller.subscribeItems(() => {
      revisions.push(controller.getItemsRevision())
    })

    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'a', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'b', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'c', invokeId: 1 })
    await flushStreamPatches()

    unsub()
    expect(revisions.length).toBeLessThanOrEqual(2)
    expect(
      controller.items.some((item) => item.kind === 'message' && item.content === 'abc')
    ).toBe(true)
  })

  it('keeps UI suspended until disk catch-up finishes so live deltas are not clobbered', async () => {
    const diskPayload = {
      ok: true as const,
      data: {
        runId: 'r1',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'from-disk' }
        ]
      }
    }
    const loadRunEvents = vi.fn().mockResolvedValue({ ok: true, data: [] })
    const listActiveRuns = vi.fn().mockResolvedValue({
      ok: true,
      data: [{ runId: 'r1', invokeId: 1, workspacePath: '/ws' }]
    })
    let controller!: ReturnType<typeof createChatStreamController>
    const loadRun = vi.fn(async () => {
      // Catch-up must still be suspended so in-flight live deltas are dropped,
      // not applied and then wiped by hydrateFromDisk.
      expect(controller.uiSuspended).toBe(true)
      controller.handleEvent({ type: 'text_delta', runId: 'r1', text: ' during', invokeId: 1 })
      expect(
        controller.items.some((i) => i.kind === 'message' && String(i.content).includes('during'))
      ).toBe(false)
      return diskPayload
    })

    // @ts-expect-error test bridge
    window.vyotiq = {
      loadRun,
      loadRunEvents,
      listActiveRuns
    }

    controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'before', invokeId: 1 })

    controller.setUiSuspended(true)
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: ' skipped', invokeId: 1 })
    expect(controller.items.some((i) => i.kind === 'message' && i.content === 'before skipped')).toBe(
      false
    )

    await controller.resumeUiIfNeeded()

    expect(controller.uiSuspended).toBe(false)
    expect(loadRun).toHaveBeenCalledWith('/ws', 'r1')
    expect(controller.items.some((i) => i.kind === 'message' && i.content === 'from-disk')).toBe(true)
    expect(
      controller.items.some((i) => i.kind === 'message' && String(i.content).includes('during'))
    ).toBe(false)
  })

  it('editAndResend truncates transcript and calls chatRewindAndStart', async () => {
    const chatRewindAndStart = vi.fn().mockResolvedValue({
      ok: true,
      data: { runId: 'r1', invokeId: 2 }
    })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewindAndStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply-2' }
    ])

    const ok = await controller.editAndResend(0, 'first edited')
    expect(ok).toBe(true)
    expect(chatRewindAndStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/ws',
        runId: 'r1',
        editMessageIndex: 0,
        editedUserMessage: { role: 'user', content: 'first edited' }
      })
    )
    expect(controller.messages).toEqual([{ role: 'user', content: 'first edited' }])
    expect(controller.messages.some((m) => m.content === 'reply-2')).toBe(false)
    expect(controller.running).toBe(true)
    const editedUser = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'user'
    )
    expect(editedUser?.kind === 'message' ? editedUser.at : undefined).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    )
  })

  it('editAndResend keeps prior user at timestamps for earlier turns', async () => {
    const chatRewindAndStart = vi.fn().mockResolvedValue({
      ok: true,
      data: { runId: 'r1', invokeId: 2 }
    })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewindAndStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply-2' }
    ])
    const firstUser = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'user' && item.content === 'first'
    )
    expect(firstUser?.kind).toBe('message')
    if (firstUser?.kind === 'message') {
      firstUser.at = '2026-01-01T00:00:00.000Z'
    }

    const ok = await controller.editAndResend(2, 'second edited')
    expect(ok).toBe(true)
    const keptFirst = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'user' && item.content === 'first'
    )
    expect(keptFirst?.kind === 'message' ? keptFirst.at : undefined).toBe(
      '2026-01-01T00:00:00.000Z'
    )
    const edited = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'user' && item.content === 'second edited'
    )
    expect(edited?.kind === 'message' ? edited.at : undefined).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('editAndResend rolls back UI when chatRewindAndStart fails', async () => {
    const chatRewindAndStart = vi.fn().mockResolvedValue({
      ok: false,
      error: 'rewind failed'
    })
    const chatCancel = vi.fn().mockResolvedValue({ ok: true, data: true })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewindAndStart, chatCancel }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    const prior = [
      { role: 'user' as const, content: 'keep me' },
      { role: 'assistant' as const, content: 'stay' },
      { role: 'user' as const, content: 'edit me' },
      { role: 'assistant' as const, content: 'drop on success' }
    ]
    controller.hydrateTranscript(prior)

    const ok = await controller.editAndResend(2, 'edited')
    expect(ok).toBe(false)
    expect(controller.messages).toEqual(prior)
    expect(controller.error).toBe('rewind failed')
    expect(controller.running).toBe(false)
  })

  it('revertToUserMessage truncates transcript and calls chatRewind without starting run', async () => {
    const chatRewind = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply-1' }
        ],
        restored: ['a.ts'],
        skipped: []
      }
    })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewind }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply-2' }
    ])

    const ok = await controller.revertToUserMessage(0)
    expect(ok).toBe(true)
    expect(chatRewind).toHaveBeenCalledWith({
      workspacePath: '/ws',
      runId: 'r1',
      userMessageIndex: 0
    })
    expect(controller.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' }
    ])
    expect(controller.running).toBe(false)
    expect(controller.pendingRun).toBe(false)
  })

  it('revertToUserMessage rolls back UI when chatRewind fails', async () => {
    const chatRewind = vi.fn().mockResolvedValue({
      ok: false,
      error: 'rewind failed'
    })
    // @ts-expect-error test bridge
    window.vyotiq = { chatRewind }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    const prior = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply-1' },
      { role: 'user' as const, content: 'second' },
      { role: 'assistant' as const, content: 'reply-2' }
    ]
    controller.hydrateTranscript(prior)

    const ok = await controller.revertToUserMessage(0)
    expect(ok).toBe(false)
    expect(controller.messages).toEqual(prior)
    expect(controller.error).toBe('rewind failed')
  })

  it('scopes network_wait reconnecting to the current turn only', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'second' }
    ])

    const priorAssistant = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'assistant'
    )
    expect(priorAssistant?.kind).toBe('message')

    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'streaming', invokeId: 1 })
    await flushStreamPatches()

    const currentAssistant = controller.items.find(
      (item) => item.kind === 'message' && item.role === 'assistant' && item.content === 'streaming'
    )
    expect(currentAssistant?.kind).toBe('message')

    controller.handleEvent({
      type: 'network_wait',
      runId: 'r1',
      attempt: 1,
      maxAttempts: 5,
      retryInMs: 1000
    })

    const priorAfter = controller.items.find((item) => item.id === priorAssistant?.id)
    const currentAfter = controller.items.find((item) => item.id === currentAssistant?.id)
    expect(priorAfter?.kind === 'message' ? priorAfter.reconnecting : undefined).toBeFalsy()
    expect(currentAfter?.kind === 'message' ? currentAfter.reconnecting : undefined).toBe(true)
  })

  it('skips advisory token_cost_hint from runNotice; keeps operational notices', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })

    controller.handleEvent({
      type: 'token_cost_hint',
      runId: 'r1',
      kind: 'long_run_task_boundary',
      message: 'Long run — consider /clear between unrelated tasks.'
    })
    expect(controller.runNotice).toBeNull()

    controller.handleEvent({
      type: 'token_cost_hint',
      runId: 'r1',
      kind: 'high_thinking_on_long_run',
      message: 'High thinking on a long run — consider Lower.'
    })
    expect(controller.runNotice).toBeNull()

    controller.handleEvent({ type: 'compaction', runId: 'r1', summary: 'summarized' })
    expect(controller.runNotice).toBe('Context summarized to stay within the model window.')

    controller.handleEvent({
      type: 'mcp_tools_omitted',
      runId: 'r1',
      omittedCount: 2
    })
    expect(controller.runNotice).toMatch(/2 MCP tools were deferred/)
  })

  it('merges unresolved writes_checkpoint rows on hydrate', async () => {
    const listActiveRuns = vi.fn().mockResolvedValue({ ok: true, data: [] })
    const loadRun = vi.fn().mockResolvedValue({
      ok: true,
      data: { messages: [], status: 'done' }
    })
    const loadRunEvents = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        {
          at: '2026-01-01T00:00:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'r1',
            checkpointId: 'cp-old',
            files: [{ path: 'a.ts', action: 'modified', undoable: true }]
          }
        },
        {
          at: '2026-01-02T00:00:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'r1',
            checkpointId: 'cp-new',
            files: [{ path: 'b.ts', action: 'modified', undoable: true }]
          }
        }
      ]
    })
    // @ts-expect-error test bridge
    window.vyotiq.listActiveRuns = listActiveRuns
    // @ts-expect-error test bridge
    window.vyotiq.loadRun = loadRun
    // @ts-expect-error test bridge
    window.vyotiq.loadRunEvents = loadRunEvents

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    await controller.syncFromDisk('r1')

    expect(controller.writeCheckpoint?.checkpointId).toBe('cp-new')
    expect(controller.writeCheckpoint?.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])
  })
})
