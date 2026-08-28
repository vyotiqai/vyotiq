import { describe, expect, it } from 'vitest'
import {
  applyFoldedMessagesWatermark,
  dropOldestTurn,
  stripLeadingOrphanToolMessages,
  stripOrphanToolMessages,
  trimHistoryToBudget
} from '@main/agent/context/historyTrim'
import type { ChatMessage } from '../../../src/shared/ipc'

function user(text: string): ChatMessage {
  return { role: 'user', content: text }
}

function assistantWithCalls(ids: string[]): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: ids.map((id) => ({ id, name: 'read', arguments: '{}' }))
  }
}

function tool(callId: string): ChatMessage {
  return { role: 'tool', toolCallId: callId, toolName: 'read', content: 'ok' }
}

describe('stripLeadingOrphanToolMessages', () => {
  it('drops leading tool rows without a preceding assistant call', () => {
    const messages = [tool('a'), user('hi')]
    expect(stripLeadingOrphanToolMessages(messages)).toEqual([user('hi')])
  })

  it('keeps tool rows preceded by their assistant turn', () => {
    const messages = [user('hi'), assistantWithCalls(['a']), tool('a')]
    expect(stripLeadingOrphanToolMessages(messages)).toEqual(messages)
  })

  it('returns [] when the window is entirely orphan tools', () => {
    expect(stripLeadingOrphanToolMessages([tool('a'), tool('b')])).toEqual([])
  })

  it('leaves empty input untouched', () => {
    expect(stripLeadingOrphanToolMessages([])).toEqual([])
  })
})

describe('stripOrphanToolMessages', () => {
  it('drops tool rows whose assistant call is absent', () => {
    const messages = [user('hi'), assistantWithCalls(['a']), tool('a'), tool('stale')]
    expect(stripOrphanToolMessages(messages)).toEqual([
      user('hi'),
      assistantWithCalls(['a']),
      tool('a')
    ])
  })

  it('drops tool rows with no toolCallId', () => {
    const orphan = { role: 'tool' as const, toolCallId: undefined, content: 'x' }
    expect(stripOrphanToolMessages([user('hi'), orphan])).toEqual([user('hi')])
  })

  it('passes sets without tool rows through untouched', () => {
    const messages = [user('hi'), { role: 'assistant' as const, content: 'done' }]
    expect(stripOrphanToolMessages(messages)).toEqual(messages)
  })
})

describe('applyFoldedMessagesWatermark', () => {
  it('advances past a clean boundary', () => {
    const messages = [user('a'), { role: 'assistant' as const, content: 'b' }, user('c')]
    const result = applyFoldedMessagesWatermark(messages, 2)
    expect(result.messages).toEqual([user('c')])
    expect(result.foldedMessages).toBe(2)
  })

  it('does not leave a leading orphan tool row', () => {
    const messages = [user('a'), user('b'), assistantWithCalls(['x']), tool('x'), user('c')]
    const result = applyFoldedMessagesWatermark(messages, 2)
    expect(result.messages[0].role).not.toBe('tool')
    expect(result.messages).toEqual([
      assistantWithCalls(['x']),
      tool('x'),
      user('c')
    ])
  })

  it('never folds away the entire history', () => {
    const messages = [user('only')]
    const result = applyFoldedMessagesWatermark(messages, 10)
    expect(result.messages).toEqual([user('only')])
    expect(result.foldedMessages).toBe(0)
  })

  it('recovers the last non-tool message from an all-tool history', () => {
    const messages = [tool('a'), tool('b')]
    const result = applyFoldedMessagesWatermark(messages, 1)
    expect(result.messages).toEqual([tool('b')])
  })
})

describe('dropOldestTurn', () => {
  it('drops a whole turn: the user message plus its full response chain', () => {
    const messages = [
      user('q1'),
      assistantWithCalls(['a1']),
      tool('a1'),
      { role: 'assistant' as const, content: 'done' },
      user('q2')
    ]
    expect(dropOldestTurn(messages)).toEqual([user('q2')])
  })

  it('drops the whole assistant+tool pair when the assistant is first', () => {
    const messages = [assistantWithCalls(['a1']), tool('a1'), user('q2')]
    expect(dropOldestTurn(messages)).toEqual([user('q2')])
  })

  it('keeps tiny inputs intact (guard: length <= 2)', () => {
    const messages = [user('a'), user('b')]
    expect(dropOldestTurn(messages)).toEqual(messages)
  })
})

describe('trimHistoryToBudget', () => {
  it('drops oldest turns until the estimate fits the budget', () => {
    const filler = 'x'.repeat(400)
    const messages: ChatMessage[] = [
      user(`turn1 ${filler}`),
      user(`turn2 ${filler}`),
      user('turn3 keep')
    ]
    const trimmed = trimHistoryToBudget(messages, 80)
    // The loop stops at two messages by design — it never trims below length 2.
    expect(trimmed).toHaveLength(2)
    expect(trimmed[trimmed.length - 1]).toEqual(user('turn3 keep'))
  })

  it('returns the working set when it already fits', () => {
    const messages = [user('tiny')]
    expect(trimHistoryToBudget(messages, 10_000)).toEqual(messages)
  })
})
