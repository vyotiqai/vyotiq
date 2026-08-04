import { describe, expect, it, vi } from 'vitest'
import type { LlmProvider } from '@main/agent/providers/types'

const compactMessages = vi.hoisted(() =>
  vi.fn(async () => ({
    summary: 'OVERFLOW_FOLD_SUMMARY_XYZ',
    createdAt: '2026-08-02T00:00:00.000Z',
    tokenEstimate: 50
  }))
)

vi.mock('@main/agent/context/compact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context/compact')>()
  return {
    ...actual,
    compactMessages: compactMessages
  }
})

vi.mock('@main/agent/context/compactionPayback', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@main/agent/context/compactionPayback')>()
  return {
    ...actual,
    shouldInvokeCompactionLlm: () => ({ invokeLlm: true, reason: 'payback' as const })
  }
})

const mockProvider: LlmProvider = {
  id: 'ollama',
  listModels: async () => [],
  streamChat: async function* () {
    yield { type: 'done' }
  }
}

describe('assembleContext overflow compaction', () => {
  it('drops the folded prefix after LLM compaction succeeds', async () => {
    compactMessages.mockClear()

    const { assembleContext } = await import('@main/agent/context/assemble')

    const foldedMarker = 'FOLDED_PREFIX_UNIQUE_MARKER_ZZZ'
    const keptMarker = 'KEPT_RECENT_UNIQUE_MARKER_YYY'
    const history: import('@shared/ipc').ChatMessage[] = []
    for (let i = 0; i < 40; i++) {
      history.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `${foldedMarker} turn ${i} ${'x'.repeat(800)}`
      })
    }
    for (let i = 0; i < 4; i++) {
      history.push({
        role: 'user',
        content: `${keptMarker} user ${i}`
      })
      history.push({
        role: 'assistant',
        content: `${keptMarker} assistant ${i}`
      })
    }

    const result = await assembleContext({
      harness: 'harness',
      messages: history,
      workspacePath: null,
      goal: 'hi',
      model: {
        id: 'test',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false,
        contextWindow: 8_000
      },
      toolsJsonEstimate: 20_000,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal,
      keepRecentTurns: 4
    })

    expect(compactMessages).toHaveBeenCalled()
    expect(result.compaction?.summary).toContain('OVERFLOW_FOLD_SUMMARY_XYZ')
    expect(result.system).toContain('OVERFLOW_FOLD_SUMMARY_XYZ')
    const wireText = result.messages.map((m) => String(m.content ?? '')).join('\n')
    expect(wireText).not.toContain(foldedMarker)
    expect(wireText).toContain(keptMarker)
  })
})
