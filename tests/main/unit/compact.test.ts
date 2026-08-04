import { describe, expect, it } from 'vitest'
import { compactMessages } from '@main/agent/context/compact'
import type { LlmProvider, StreamChunk } from '@main/agent/providers/types'
import type { ChatMessage } from '@shared/ipc'

function mockProvider(chunks: StreamChunk[]): LlmProvider {
  return {
    id: 'openai',
    async *streamChat() {
      for (const chunk of chunks) yield chunk
    },
    listModels: async () => []
  }
}

function mockProviderPerCall(handlers: Array<() => StreamChunk[]>): LlmProvider {
  let call = 0
  return {
    id: 'openai',
    async *streamChat() {
      const chunks = handlers[Math.min(call, handlers.length - 1)]()
      call++
      for (const chunk of chunks) yield chunk
    },
    listModels: async () => []
  }
}

const history: ChatMessage[] = [
  { role: 'user', content: 'Fix the search tool' },
  { role: 'assistant', content: 'I updated search.ts' }
]

const structuredJson = JSON.stringify({
  sessionIntent: 'Fix search',
  filesTouched: ['src/search.ts'],
  keyDecisions: ['Use gitignore matcher'],
  constraints: [],
  openBlockers: [],
  nextSteps: ['Add tests']
})

describe('compactMessages', () => {
  it('returns null when aborted before work', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await compactMessages({
      provider: mockProvider([]),
      model: 'gpt-4o',
      signal: controller.signal,
      messages: history
    })
    expect(result).toBeNull()
  })

  it('returns null for empty history', async () => {
    const result = await compactMessages({
      provider: mockProvider([]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: []
    })
    expect(result).toBeNull()
  })

  it('uses structured output when the provider returns valid JSON', async () => {
    const result = await compactMessages({
      provider: mockProvider([{ type: 'text', text: structuredJson }]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true
    })
    expect(result).not.toBeNull()
    expect(result?.summary).toMatch(/Fix search/i)
    expect(result?.summary).toMatch(/search\.ts/i)
    expect(result?.tokenEstimate).toBeGreaterThan(0)
    expect(result?.createdAt).toBeTruthy()
  })

  it('falls back to freeform when structured output fails', async () => {
    const result = await compactMessages({
      provider: mockProviderPerCall([
        () => [{ type: 'error', error: 'schema rejected' }],
        () => [
          { type: 'text', text: '## Session Intent\nShip feature\n\n## Next Steps\n- deploy' }
        ]
      ]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true
    })
    expect(result?.summary).toMatch(/Ship feature/i)
  })

  it('uses freeform path when structured output is disabled', async () => {
    const result = await compactMessages({
      provider: mockProvider([
        { type: 'text', text: '## Session Intent\nManual summary\n\n## Next Steps\n- done' }
      ]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: false
    })
    expect(result?.summary).toMatch(/Manual summary/i)
  })

  it('returns null when both structured and freeform produce no summary', async () => {
    const result = await compactMessages({
      provider: mockProviderPerCall([
        () => [{ type: 'error', error: 'structured failed' }],
        () => [{ type: 'error', error: 'freeform failed' }]
      ]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true
    })
    expect(result).toBeNull()
  })

  it('returns null when aborted after structured compaction fails', async () => {
    const controller = new AbortController()
    let freeformCalls = 0

    const result = await compactMessages({
      provider: mockProviderPerCall([
        () => {
          controller.abort()
          return [{ type: 'error', error: 'structured failed' }]
        },
        () => {
          freeformCalls++
          return [{ type: 'text', text: 'freeform unwanted' }]
        }
      ]),
      model: 'gpt-4o',
      signal: controller.signal,
      messages: history,
      supportsStructuredOutput: true
    })

    expect(result).toBeNull()
    expect(freeformCalls).toBe(0)
  })

  it('retains prior summary across successive folds', async () => {
    const result = await compactMessages({
      provider: mockProvider([{ type: 'text', text: structuredJson }]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true,
      priorSummary: '## Session Intent\nEarlier fact ALPHA_UNIQUE'
    })
    expect(result?.summary).toMatch(/ALPHA_UNIQUE/)
    expect(result?.summary).toMatch(/Fix search/i)
    expect(result?.summary).toContain('---')
  })
})
