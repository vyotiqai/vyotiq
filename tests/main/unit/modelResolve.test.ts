import { beforeEach, describe, expect, it, vi } from 'vitest'

const listProviderModelsMock = vi.hoisted(() => vi.fn())

vi.mock('@main/agent/providers', () => ({ listProviderModels: listProviderModelsMock }))

import { resolveModelInfo } from '@main/agent/modelResolve'

const SIGNAL = new AbortController().signal

describe('resolveModelInfo', () => {
  beforeEach(() => {
    listProviderModelsMock.mockReset()
  })

  it('keeps a live catalog context window when present', async () => {
    listProviderModelsMock.mockResolvedValue({
      models: [{ id: 'deepseek-chat', contextWindow: 65_536, supportsTools: true }]
    })
    const info = await resolveModelInfo('openai', 'deepseek-chat', null, undefined, SIGNAL)
    expect(info.id).toBe('deepseek-chat')
    expect(info.contextWindow).toBe(65_536)
  })

  it('falls back to seed metadata for a seeded ollama model absent from the live list', async () => {
    listProviderModelsMock.mockResolvedValue({ models: [] })
    const info = await resolveModelInfo('ollama', 'qwen2.5', null, undefined, SIGNAL)
    expect(info.id).toBe('qwen2.5')
    expect(info.contextWindow).toBeGreaterThan(0)
  })

  it('uses the conservative 128k default for fully unknown models', async () => {
    listProviderModelsMock.mockResolvedValue({ models: [] })
    const info = await resolveModelInfo(
      'custom',
      'totally-unknown-model-xyz',
      null,
      undefined,
      SIGNAL
    )
    expect(info.id).toBe('totally-unknown-model-xyz')
    expect(info.contextWindow).toBe(128_000)
  })

  it('passes provider credentials through to the catalog listing', async () => {
    listProviderModelsMock.mockResolvedValue({ models: [] })
    await resolveModelInfo('openai', 'm', 'sk-test-key', 'https://example.invalid/v1', SIGNAL)
    expect(listProviderModelsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        apiKey: 'sk-test-key',
        baseUrl: 'https://example.invalid/v1',
        model: 'm'
      })
    )
  })
})
