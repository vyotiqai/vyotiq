import { describe, expect, it } from 'vitest'
import {
  registerRunAbort,
  clearRunAbort,
  resetActiveRunsForTests,
  listActiveRuns,
  isActive,
  markRunTurnComplete,
  enqueueFollowUp,
  takeNextFollowUp,
  takeNextReadyFollowUp,
  drainReadyFollowUps,
  drainFollowUps,
  removeFollowUp,
  updateFollowUp,
  promoteFollowUp,
  hasPendingFollowUps,
  hasReadyFollowUps,
  peekFollowUps,
  setLateFollowUpDropped,
  takeLateFollowUpDropped,
  setStreamInterrupt,
  chatCancelResult,
  tryBeginRunClosing,
  cancelRun
} from '@main/agent/runRegistry'

describe('runRegistry listActiveRuns', () => {
  it('keeps the run listed until clearRunAbort (including turn-complete unwind)', () => {
    resetActiveRunsForTests()
    const runId = 'session-run'
    const first = registerRunAbort(runId, '/ws')
    expect(listActiveRuns()).toEqual([
      { runId, workspacePath: '/ws', invokeId: first.invokeId, pendingFollowUps: [] }
    ])
    expect(isActive(runId)).toBe(true)

    markRunTurnComplete(runId, first.invokeId)
    expect(isActive(runId)).toBe(true)
    expect(listActiveRuns()).toEqual([
      { runId, workspacePath: '/ws', invokeId: first.invokeId, pendingFollowUps: [] }
    ])

    // No overlapping invoke while unwinding.
    const again = registerRunAbort(runId, '/ws')
    expect(again.invokeId).toBe(first.invokeId)

    clearRunAbort(runId, first.invokeId)
    expect(isActive(runId)).toBe(false)
    expect(listActiveRuns()).toEqual([])

    const second = registerRunAbort(runId, '/ws')
    expect(second.invokeId).not.toBe(first.invokeId)
    expect(listActiveRuns()).toEqual([
      { runId, workspacePath: '/ws', invokeId: second.invokeId, pendingFollowUps: [] }
    ])

    clearRunAbort(runId, second.invokeId)
    expect(listActiveRuns()).toEqual([])
  })
})

describe('runRegistry follow-ups', () => {
  it('queues, drains, and only soft-aborts on promote', () => {
    resetActiveRunsForTests()
    const runId = 'follow-up-run'
    registerRunAbort(runId, '/ws')
    const streamAbort = new AbortController()
    setStreamInterrupt(runId, streamAbort)

    const queued = enqueueFollowUp(runId, { role: 'user', content: 'steer' })
    expect(queued.ok).toBe(true)
    if (!queued.ok) return
    expect(queued.position).toBe(1)
    expect(hasPendingFollowUps(runId)).toBe(true)
    expect(hasReadyFollowUps(runId)).toBe(false)
    expect(streamAbort.signal.aborted).toBe(false)

    const second = enqueueFollowUp(runId, { role: 'user', content: 'again' })
    expect(second.ok).toBe(true)
    if (!second.ok) return

    const promoted = promoteFollowUp(runId, queued.id)
    expect(promoted).toEqual({ ok: true, queueLength: 2 })
    expect(hasReadyFollowUps(runId)).toBe(true)
    expect(streamAbort.signal.aborted).toBe(true)

    const removed = removeFollowUp(runId, second.id)
    expect(removed).toEqual({ ok: true, removed: true, queueLength: 1 })

    const drained = takeNextReadyFollowUp(runId)
    expect(drained?.message).toEqual({ role: 'user', content: 'steer' })
    expect(drained?.ready).toBe(true)
    expect(hasPendingFollowUps(runId)).toBe(false)
  })

  it('rejects follow-ups when the run is inactive and clears on cancel', () => {
    resetActiveRunsForTests()
    expect(enqueueFollowUp('missing', { role: 'user', content: 'x' }).ok).toBe(false)

    const runId = 'cancel-follow-ups'
    registerRunAbort(runId, '/ws')
    enqueueFollowUp(runId, { role: 'user', content: 'queued' })
    expect(chatCancelResult(runId)).toEqual({ ok: true, data: true })
    expect(hasPendingFollowUps(runId)).toBe(false)
  })

  it('rejects enqueue after cancel abort so follow-ups are not ack-then-dropped', () => {
    resetActiveRunsForTests()
    const runId = 'abort-reject-follow-up'
    registerRunAbort(runId, '/ws')
    expect(cancelRun(runId)).toBe(true)
    expect(enqueueFollowUp(runId, { role: 'user', content: 'too late' })).toEqual({
      ok: false,
      error: 'Run is not active'
    })
  })

  it('tryBeginRunClosing keeps the turn open for any queued follow-up', () => {
    resetActiveRunsForTests()
    const runId = 'close-race'
    const handle = registerRunAbort(runId, '/ws')
    expect(tryBeginRunClosing(runId, handle.invokeId)).toBe('closed')

    resetActiveRunsForTests()
    const handle2 = registerRunAbort(runId, '/ws')
    enqueueFollowUp(runId, { role: 'user', content: 'steer' })
    expect(tryBeginRunClosing(runId, handle2.invokeId)).toBe('has_followups')
    expect(drainFollowUps(runId)).toHaveLength(1)
    expect(tryBeginRunClosing(runId, handle2.invokeId)).toBe('closed')
  })

  it('preserves follow-ups across markRunTurnComplete and exposes them on listActiveRuns', () => {
    resetActiveRunsForTests()
    const runId = 'preserve-follow-ups'
    const handle = registerRunAbort(runId, '/ws')
    const queued = enqueueFollowUp(runId, { role: 'user', content: 'late steer' })
    expect(queued.ok).toBe(true)
    if (!queued.ok) return

    expect(listActiveRuns()[0]?.pendingFollowUps).toEqual([
      { id: queued.id, preview: 'late steer' }
    ])

    markRunTurnComplete(runId, handle.invokeId)
    // Queue is not wiped by turn-complete (loop drains or cancel clears).
    expect(peekFollowUps(runId)).toHaveLength(1)
    expect(listActiveRuns()).toEqual([
      {
        runId,
        workspacePath: '/ws',
        invokeId: handle.invokeId,
        pendingFollowUps: [{ id: queued.id, preview: 'late steer' }]
      }
    ])
  })

  it('takes queued follow-ups one at a time in FIFO order', () => {
    resetActiveRunsForTests()
    const runId = 'fifo-next'
    registerRunAbort(runId, '/ws')
    const first = enqueueFollowUp(runId, { role: 'user', content: 'first' })
    const second = enqueueFollowUp(runId, { role: 'user', content: 'second' })
    expect(first.ok && second.ok).toBe(true)

    const one = takeNextFollowUp(runId)
    expect(one?.message.content).toBe('first')
    expect(peekFollowUps(runId)).toHaveLength(1)

    const two = takeNextFollowUp(runId)
    expect(two?.message.content).toBe('second')
    expect(peekFollowUps(runId)).toHaveLength(0)
  })

  it('marks promoted follow-ups ready for drain', () => {
    resetActiveRunsForTests()
    const runId = 'ready-flag'
    registerRunAbort(runId, '/ws')
    const queued = enqueueFollowUp(runId, { role: 'user', content: 'wait' })
    expect(queued.ok).toBe(true)
    if (!queued.ok) return
    expect(hasReadyFollowUps(runId)).toBe(false)
    promoteFollowUp(runId, queued.id)
    expect(hasReadyFollowUps(runId)).toBe(true)
    expect(drainReadyFollowUps(runId)[0]?.ready).toBe(true)
  })

  it('updates and promotes queued follow-ups', () => {
    resetActiveRunsForTests()
    const runId = 'follow-up-actions'
    registerRunAbort(runId, '/ws')
    const first = enqueueFollowUp(runId, { role: 'user', content: 'first' })
    const second = enqueueFollowUp(runId, { role: 'user', content: 'second' })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    const updated = updateFollowUp(runId, second.id, { role: 'user', content: 'second edited' })
    expect(updated).toEqual({ ok: true, preview: 'second edited' })
    expect(peekFollowUps(runId).map((entry) => entry.message.content)).toEqual([
      'first',
      'second edited'
    ])

    const promoted = promoteFollowUp(runId, second.id)
    expect(promoted).toEqual({ ok: true, queueLength: 2 })
    expect(peekFollowUps(runId).map((entry) => entry.message.content)).toEqual([
      'second edited',
      'first'
    ])
  })
})

describe('runRegistry cancel clears pending gates', () => {
  it('chatCancelResult clears pending agent questions', async () => {
    resetActiveRunsForTests()
    const {
      registerQuestionSender,
      askQuestionThroughRenderer,
      listPendingAgentQuestions,
      resetAgentQuestionForTests
    } = await import('@main/agent/agentQuestion')
    resetAgentQuestionForTests()
    const runId = 'cancel-pending-q'
    registerRunAbort(runId, '/ws')
    registerQuestionSender(runId, () => {})
    const pending = askQuestionThroughRenderer(
      {
        requestId: 'q1',
        runId,
        toolCallId: 't1',
        questions: [{ id: 'q1', prompt: 'Ready?', type: 'single', options: ['yes', 'no'] }]
      },
      new AbortController().signal
    )
    expect(listPendingAgentQuestions(runId)).toHaveLength(1)
    expect(chatCancelResult(runId)).toEqual({ ok: true, data: true })
    expect(listPendingAgentQuestions(runId)).toHaveLength(0)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    resetAgentQuestionForTests()
  })

  it('soft-steer keeps parent and nested ask_question waiters parked', async () => {
    resetActiveRunsForTests()
    const {
      registerQuestionSender,
      askQuestionThroughRenderer,
      listPendingAgentQuestions,
      resetAgentQuestionForTests,
      resolveAgentQuestion
    } = await import('@main/agent/agentQuestion')
    resetAgentQuestionForTests()

    const runId = 'soft-steer-nested-gates'
    const handle = registerRunAbort(runId, '/ws')
    registerQuestionSender(runId, () => {})

    const parentQ = askQuestionThroughRenderer(
      {
        requestId: 'parent-q',
        runId,
        toolCallId: 'tq-parent',
        questions: [{ id: 'q1', prompt: 'Parent?', type: 'single', options: ['a', 'b'] }]
      },
      new AbortController().signal,
      handle.invokeId
    )
    const nestedQ = askQuestionThroughRenderer(
      {
        requestId: 'nested-q',
        runId,
        toolCallId: 'tq-nested',
        questions: [{ id: 'q1', prompt: 'Nested?', type: 'single', options: ['a', 'b'] }]
      },
      new AbortController().signal,
      handle.invokeId
    )
    await Promise.resolve()

    expect(listPendingAgentQuestions(runId)).toHaveLength(2)

    // Follow-up must not abort open questions: they gate nothing destructive,
    // so the user can finish answering while the message waits in the queue.
    expect(enqueueFollowUp(runId, { role: 'user', content: 'steer' }).ok).toBe(true)
    expect(listPendingAgentQuestions(runId)).toHaveLength(2)

    resolveAgentQuestion({
      requestId: 'parent-q',
      runId,
      answers: [{ questionId: 'q1', values: ['a'] }]
    })
    await expect(parentQ).resolves.toEqual([{ questionId: 'q1', values: ['a'] }])

    resolveAgentQuestion({
      requestId: 'nested-q',
      runId,
      answers: [{ questionId: 'q1', values: ['a'] }]
    })
    await expect(nestedQ).resolves.toEqual([{ questionId: 'q1', values: ['a'] }])

    resetAgentQuestionForTests()
  })
})

describe('runRegistry late follow-up dropped', () => {
  it('buffers and takes a late follow_up_dropped event', () => {
    resetActiveRunsForTests()
    const runId = 'late-drop'
    const event = {
      type: 'follow_up_dropped' as const,
      runId,
      ids: ['fu-1'],
      reason: 'run_ended'
    }
    setLateFollowUpDropped(runId, event)
    expect(takeLateFollowUpDropped(runId)).toEqual(event)
    expect(takeLateFollowUpDropped(runId)).toBeUndefined()
  })
})
