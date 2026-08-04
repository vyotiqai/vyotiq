import { describe, expect, it } from 'vitest'
import { allocateBudget, contentWindow, contextWindowFor, effectiveWindow } from '@main/agent/context/budget'
import { estimateTextTokens, estimateMessagesTokens } from '@main/agent/context/estimate'
import { trimToolResults } from '@main/agent/context/toolTrim'
import { preserveRecentMessages } from '@main/agent/context/compact'
import {
  applyFoldedMessagesWatermark,
  dropOldestTurn,
  stripLeadingOrphanToolMessages,
  trimHistoryToBudget
} from '@main/agent/context/historyTrim'
import { anthropicNativeOptions } from '@main/agent/context/anthropicContext'
import { stripThinkingForCompaction } from '@main/agent/context/assemble'
import type { ChatMessage } from '@shared/ipc'

describe('context budget + trim', () => {
  it('allocates budget layers totaling ~100%', () => {
    const model = {
      id: 'x',
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      supportsTools: true,
      supportsVision: false,
      contextWindow: 100_000
    }
    expect(contextWindowFor(model)).toBe(100_000)
    const b = allocateBudget(model)
    expect(b.system + b.tools + b.memoryWorkspace + b.history + b.buffer).toBe(100_000)
  })

  it('contentWindow equals non-buffer shares (does not double-subtract buffer)', () => {
    const model = {
      id: 'x',
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      supportsTools: true,
      supportsVision: false,
      contextWindow: 100_000
    }
    expect(contentWindow(model)).toBe(effectiveWindow(model))
    expect(contentWindow(model)).toBe(85_000)
  })

  it('estimates tokens heuristically', () => {
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(
      estimateMessagesTokens([{ role: 'user', content: 'hello world!!' }])
    ).toBeGreaterThan(0)
  })

  it('clears old ephemeral tool bodies and keeps last N (never stubs read)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: '1', toolName: 'terminal', content: 'OLD1'.repeat(100) },
      { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: '2', toolName: 'terminal', content: 'OLD2'.repeat(100) },
      { role: 'assistant', content: '', toolCalls: [{ id: '3', name: 'terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: '3', toolName: 'terminal', content: 'NEW'.repeat(100) },
      { role: 'assistant', content: '', toolCalls: [{ id: '4', name: 'terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: '4', toolName: 'terminal', content: 'NEWER'.repeat(100) }
    ]
    const trimmed = trimToolResults(msgs, 3)
    const tools = trimmed.filter((m) => m.role === 'tool')
    expect(tools[0].content).toBe('[cleared]')
    expect(String(tools[1].content)).not.toContain('cleared')
  })

  it('never stubs durable ask_question / todo / memory; clears old reads', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'a' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: '1', name: 'ask_question', arguments: '{}' }]
      },
      {
        role: 'tool',
        toolCallId: '1',
        toolName: 'ask_question',
        content: 'User answered: Productionize'
      },
      { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: '2', toolName: 'read', content: 'FILEBODY'.repeat(50) },
      { role: 'assistant', content: '', toolCalls: [{ id: '3', name: 'terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: '3', toolName: 'terminal', content: 'TERM'.repeat(50) },
      { role: 'assistant', content: '', toolCalls: [{ id: '4', name: 'terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: '4', toolName: 'terminal', content: 'TERM2'.repeat(50) },
      { role: 'assistant', content: '', toolCalls: [{ id: '5', name: 'terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: '5', toolName: 'terminal', content: 'TERM3'.repeat(50) }
    ]
    const trimmed = trimToolResults(msgs, 1)
    const ask = trimmed.find((m) => m.toolName === 'ask_question')
    const read = trimmed.find((m) => m.toolName === 'read')
    const terms = trimmed.filter((m) => m.toolName === 'terminal')
    expect(ask?.content).toBe('User answered: Productionize')
    expect(read?.content).toBe('[cleared]')
    expect(terms.filter((t) => t.content === '[cleared]').length).toBeGreaterThanOrEqual(1)
    expect(terms.some((t) => String(t.content).includes('TERM3'))).toBe(true)
  })









  it('preserves recent user turns', () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: `u${i}` })
      msgs.push({ role: 'assistant', content: `a${i}` })
    }
    const kept = preserveRecentMessages(msgs, 3)
    expect(kept.some((m) => m.content === 'u17')).toBe(true)
    expect(kept.some((m) => m.content === 'u0')).toBe(false)
  })

  it('drops oldest turn without orphaning tool results', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'old' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'file' },
      { role: 'assistant', content: 'done old' },
      { role: 'user', content: 'new' },
      { role: 'assistant', content: 'ok' }
    ]
    const dropped = dropOldestTurn(msgs)
    expect(dropped[0]).toMatchObject({ role: 'user', content: 'new' })
    expect(dropped.some((m) => m.role === 'tool')).toBe(false)
  })

  it('stripLeadingOrphanToolMessages removes a sole orphan tool (foldedMessages=2 case)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'file' }
    ]
    const applied = applyFoldedMessagesWatermark(msgs, 2)
    expect(applied.messages[0].role).not.toBe('tool')
    expect(applied.messages.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('preserveRecentMessages never returns a leading orphan tool', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u0' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'x'.repeat(8000) }
    ]
    const model = {
      id: 'x',
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      supportsTools: true,
      supportsVision: false,
      contextWindow: 1000
    }
    const kept = preserveRecentMessages(msgs, 5, 200, model)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept[0].role).not.toBe('tool')
  })

  it('trims history to budget without starting on a tool message', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u0 ' + 'x'.repeat(4000) },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'y'.repeat(4000) },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' }
    ]
    const trimmed = trimHistoryToBudget(msgs, 50)
    expect(trimmed[0].role).not.toBe('tool')
    expect(trimmed.some((m) => m.role === 'user' && m.content === 'u1')).toBe(true)
  })

  it('scales anthropic compact trigger to model context window', () => {
    const opts = anthropicNativeOptions('anthropic', {
      id: 'claude-haiku-4-5',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsVision: true,
      contextWindow: 32_000
    })
    expect(opts.compactTriggerTokens).toBeGreaterThanOrEqual(8_000)
    expect(opts.compactTriggerTokens).toBeLessThan(50_000)
    expect(opts.clearToolUsesKeep).toBe(3)
    // Clear floor scales with window — must stay reachable on mid-size models.
    expect(opts.clearToolUsesTriggerTokens).toBeLessThan(32_000)
    expect(opts.clearToolUsesTriggerTokens).toBeGreaterThan(0)
    expect(opts.clearToolUsesAtLeastTokens).toBe(5_000)
    expect(opts.clearToolUsesExcludeTools).toEqual(
      expect.arrayContaining(['memory_read', 'todo_write', 'ask_question'])
    )
    expect(opts.clearToolUsesExcludeTools).not.toContain('read')
  })

  it('soft-caps anthropic server compact/clear triggers on huge windows', () => {
    const opts = anthropicNativeOptions('anthropic', {
      id: 'claude-opus-huge',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsVision: true,
      contextWindow: 1_000_000
    })
    expect(opts.compactTriggerTokens).toBe(64_000)
    expect(opts.clearToolUsesTriggerTokens).toBe(64_000)
  })

  it('overflow strip drops reasoningState as well as thinking', () => {
    const stripped = stripThinkingForCompaction([
      {
        role: 'assistant',
        content: 'ok',
        thinking: 'ui only',
        reasoningState: { kind: 'openai_compat', reasoningContent: 'wire replay' }
      },
      { role: 'user', content: 'hi' }
    ])
    expect(stripped[0]).toEqual({ role: 'assistant', content: 'ok' })
    expect(stripped[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('strips images when model lacks vision', async () => {
    const { stripImagesFromMessages } = await import('@main/agent/context/stripImages')
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', url: 'data:image/png;base64,aa' }
        ]
      }
    ]
    const stripped = stripImagesFromMessages(msgs)
    expect(typeof stripped[0].content).toBe('string')
    expect(String(stripped[0].content)).toContain('omitted')
    expect(String(stripped[0].content)).toContain('see')
  })

  it('strips audio and native files when wire caps disallow them', async () => {
    const { stripUnsupportedModalitiesFromMessages } = await import(
      '@main/agent/context/stripImages'
    )
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'audio', url: 'data:audio/wav;base64,QQ==' },
          {
            type: 'file_native',
            name: 'a.pdf',
            mime: 'application/pdf',
            data: 'AAAA'
          }
        ]
      }
    ]
    const stripped = stripUnsupportedModalitiesFromMessages(msgs, {
      image: true,
      audio: false,
      fileNative: false
    })
    const text = typeof stripped[0]!.content === 'string'
      ? stripped[0]!.content
      : JSON.stringify(stripped[0]!.content)
    expect(text).toContain('audio omitted')
    expect(text).toContain('file omitted')
    expect(text).toContain('hi')
  })
})
