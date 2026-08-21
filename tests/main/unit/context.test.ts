import { describe, expect, it } from 'vitest'
import { allocateBudget, contentWindow, contextWindowFor, effectiveWindow } from '@main/agent/context/budget'
import { estimateTextTokens, estimateMessagesTokens } from '@main/agent/context/estimate'
import { preserveRecentMessages } from '@main/agent/context/compact'
import {
  applyFoldedMessagesWatermark,
  stripLeadingOrphanToolMessages
} from '@main/agent/context/foldWatermark'
import { anthropicNativeOptions } from '@main/agent/context/anthropicContext'
import type { ChatMessage } from '@shared/ipc'

describe('context budget', () => {
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

  it('contentWindow equals non-buffer shares', () => {
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

  it('buffer layer reflects remaining content budget headroom', async () => {
    const { assembleContext } = await import('@main/agent/context/assemble')
    const model = {
      id: 'x',
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      supportsTools: true,
      supportsVision: false,
      contextWindow: 100_000
    }
    const result = await assembleContext({
      harness: 'harness',
      workspacePath: process.cwd(),
      goal: 'goal',
      messages: [{ role: 'user', content: 'hello' }],
      toolsJsonEstimate: 1000,
      model,
      providerId: 'ollama',
      provider: { stream: async function* () {} } as never,
      signal: new AbortController().signal
    })
    const used = result.layers.system + result.layers.history + result.layers.tools
    expect(result.layers.buffer).toBe(Math.max(0, 85_000 - used))
  })

  it('estimates tokens heuristically', () => {
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(
      estimateMessagesTokens([{ role: 'user', content: 'hello world!!' }])
    ).toBeGreaterThan(0)
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

  it('stripLeadingOrphanToolMessages removes a sole orphan tool', () => {
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

  it('disables anthropic server-side context management (LLM compact is client-only)', () => {
    const opts = anthropicNativeOptions('anthropic', {
      id: 'claude-haiku-4-5',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsVision: true,
      contextWindow: 32_000
    })
    expect(opts.enableContextManagement).toBe(false)
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
})
