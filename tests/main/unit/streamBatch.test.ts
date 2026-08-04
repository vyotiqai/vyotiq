import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  ChatEventBatcher,
  ChatEventDispatcher,
  getChatEventBatchStats,
  resetChatEventBatchStats,
  resetChatEventDispatcher,
  setChatEventActivePathResolver
} from '@main/ipc/streamBatch'
import type { AgentEvent } from '@shared/ipc'

describe('ChatEventBatcher', () => {
  let sent: AgentEvent[]

  beforeEach(() => {
    sent = []
    resetChatEventBatchStats()
    resetChatEventDispatcher()
    setChatEventActivePathResolver(() => null)
    vi.useFakeTimers()
  })

  afterEach(() => {
    setChatEventActivePathResolver(null)
    resetChatEventDispatcher()
    vi.useRealTimers()
  })

  it('preserves interleaved thinking and text order within a batch window', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({ type: 'thinking_delta', runId: 'run-1', text: 'reason ' })
    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'answer' })
    batcher.push({ type: 'thinking_delta', runId: 'run-1', text: 'more' })

    vi.advanceTimersByTime(16)

    expect(sent.map((ev) => ev.type)).toEqual([
      'thinking_delta',
      'text_delta',
      'thinking_delta'
    ])
    expect(sent[0]).toMatchObject({ type: 'thinking_delta', text: 'reason ' })
    expect(sent[1]).toMatchObject({ type: 'text_delta', text: 'answer' })
    expect(sent[2]).toMatchObject({ type: 'thinking_delta', text: 'more' })
  })

  it('coalesces consecutive segments of the same kind', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'hel' })
    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'lo' })

    vi.advanceTimersByTime(16)

    expect(sent).toEqual([{ type: 'text_delta', runId: 'run-1', text: 'hello' }])
  })

  it('coalesces terminal_output_delta for the same toolCallId and stream', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({
      type: 'terminal_output_delta',
      runId: 'run-1',
      toolCallId: 't1',
      text: 'hel',
      stream: 'stdout'
    })
    batcher.push({
      type: 'terminal_output_delta',
      runId: 'run-1',
      toolCallId: 't1',
      text: 'lo\n',
      stream: 'stdout'
    })

    vi.advanceTimersByTime(16)

    expect(sent).toEqual([
      {
        type: 'terminal_output_delta',
        runId: 'run-1',
        toolCallId: 't1',
        text: 'hello\n',
        stream: 'stdout'
      }
    ])
  })

  it('flushes pending deltas before non-delta events', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({ type: 'thinking_delta', runId: 'run-1', text: 'think' })
    batcher.push({ type: 'status', runId: 'run-1', status: 'done' })

    expect(sent.map((ev) => ev.type)).toEqual(['thinking_delta', 'status'])
  })

  it('batches tool_call_delta with pending text and preserves order', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'Looking up.' })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'c1',
      name: 'read',
      argumentsDelta: '{"p'
    })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'c1',
      name: 'read',
      argumentsDelta: 'ath"}'
    })

    vi.advanceTimersByTime(16)

    expect(sent.map((ev) => ev.type)).toEqual(['text_delta', 'tool_call_delta'])
    expect(sent[0]).toMatchObject({ type: 'text_delta', text: 'Looking up.' })
    expect(sent[1]).toMatchObject({
      type: 'tool_call_delta',
      toolCallId: 'c1',
      name: 'read',
      argumentsDelta: '{"path"}'
    })
  })

  it('coalesces tool_call_delta for the same toolCallId', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'toolu_1',
      name: 'read',
      argumentsDelta: ''
    })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'toolu_1',
      name: 'read',
      argumentsDelta: '{"a":1}'
    })

    expect(sent).toEqual([])
    vi.advanceTimersByTime(16)

    expect(sent).toEqual([
      {
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'toolu_1',
        name: 'read',
        argumentsDelta: '{"a":1}'
      }
    ])
  })

  it('keeps separate toolCallIds as separate segments', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'a',
      name: 'read',
      argumentsDelta: '1'
    })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'b',
      name: 'grep',
      argumentsDelta: '2'
    })

    vi.advanceTimersByTime(16)

    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ toolCallId: 'a', argumentsDelta: '1' })
    expect(sent[1]).toMatchObject({ toolCallId: 'b', argumentsDelta: '2' })
  })

  it('preserves invoke ids on batched deltas and keeps thinking steps separate', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({
      type: 'thinking_delta',
      runId: 'run-1',
      invokeId: 7,
      step: 1,
      text: 'first'
    })
    batcher.push({
      type: 'thinking_delta',
      runId: 'run-1',
      invokeId: 7,
      step: 2,
      text: 'second'
    })
    batcher.push({ type: 'text_delta', runId: 'run-1', invokeId: 7, text: 'answer' })

    vi.advanceTimersByTime(16)

    expect(sent).toEqual([
      { type: 'thinking_delta', runId: 'run-1', invokeId: 7, step: 1, text: 'first' },
      { type: 'thinking_delta', runId: 'run-1', invokeId: 7, step: 2, text: 'second' },
      { type: 'text_delta', runId: 'run-1', invokeId: 7, text: 'answer' }
    ])
  })

  it('tracks push vs sent counts for baseline measurement', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'a' })
    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'b' })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 't1',
      argumentsDelta: 'x'
    })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 't1',
      argumentsDelta: 'y'
    })

    expect(getChatEventBatchStats().pushed).toBe(4)
    expect(getChatEventBatchStats().sent).toBe(0)

    vi.advanceTimersByTime(16)

    const stats = getChatEventBatchStats()
    expect(stats.sent).toBe(2)
    expect(stats.byType['text_delta']).toBe(2)
    expect(stats.byType['tool_call_delta']).toBe(2)
  })
})

describe('ChatEventDispatcher priority', () => {
  beforeEach(() => {
    resetChatEventBatchStats()
    resetChatEventDispatcher()
    vi.useFakeTimers()
  })

  afterEach(() => {
    setChatEventActivePathResolver(null)
    resetChatEventDispatcher()
    vi.useRealTimers()
  })

  it('flushes active-workspace deltas before background on shared timer', () => {
    const order: string[] = []
    setChatEventActivePathResolver(() => '/ws-active')

    const dispatcher = new ChatEventDispatcher()
    dispatcher.attach('run-bg', '/ws-bg', (ev) => order.push(`bg:${ev.type}`))
    dispatcher.attach('run-fg', '/ws-active', (ev) => order.push(`fg:${ev.type}`))

    dispatcher.push('run-bg', { type: 'text_delta', runId: 'run-bg', text: 'b' })
    dispatcher.push('run-fg', { type: 'text_delta', runId: 'run-fg', text: 'a' })

    // Active path schedules 16ms; advancing 16 should flush both with fg first.
    vi.advanceTimersByTime(16)

    expect(order[0]).toBe('fg:text_delta')
    expect(order[1]).toBe('bg:text_delta')
  })

  it('keeps latest background usage per step', () => {
    const sent: AgentEvent[] = []
    setChatEventActivePathResolver(() => '/ws-active')

    const dispatcher = new ChatEventDispatcher()
    dispatcher.attach('run-bg', '/ws-bg', (ev) => sent.push(ev))

    dispatcher.push('run-bg', {
      type: 'step_usage',
      runId: 'run-bg',
      step: 1,
      inputTokens: 1,
      outputTokens: 1
    })
    dispatcher.push('run-bg', {
      type: 'step_usage',
      runId: 'run-bg',
      step: 1,
      inputTokens: 3,
      outputTokens: 3
    })
    dispatcher.push('run-bg', {
      type: 'step_usage',
      runId: 'run-bg',
      step: 2,
      inputTokens: 9,
      outputTokens: 9
    })

    vi.advanceTimersByTime(80)

    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ type: 'step_usage', inputTokens: 3, step: 1 })
    expect(sent[1]).toMatchObject({ type: 'step_usage', inputTokens: 9, step: 2 })
  })
})
