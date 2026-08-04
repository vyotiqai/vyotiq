import { afterEach, describe, expect, it, vi } from 'vitest'
import { ollamaProvider } from '@main/agent/providers/openai'
import {
  resetDnsLookupForTests,
  setDnsLookupForTests,
  setPublicFetchForTests
} from '@main/agent/tools/webFetch'

vi.mock('@shared/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }
}))

const PUBLIC_IP = '93.184.216.34'

afterEach(() => {
  resetDnsLookupForTests()
  setPublicFetchForTests(null)
})

describe('ollama cloud catalog auth', () => {
  it('sends Bearer on /v1/models and /api/tags for cloud hosts', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    const seen: Array<{ url: string; auth?: string }> = []
    setPublicFetchForTests(async (url, _addresses, _signal, headers) => {
      seen.push({ url: url.href, auth: headers?.Authorization })
      if (url.pathname.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-oss:120b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'gpt-oss:120b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('not found', { status: 404 })
    })

    const models = await ollamaProvider.listModels({
      baseUrl: 'https://ollama.com',
      apiKey: 'test-ollama-key',
      signal: AbortSignal.timeout(2000)
    })

    expect(models.some((m) => m.id === 'gpt-oss:120b')).toBe(true)
    const modelsCall = seen.find((s) => s.url.includes('/v1/models'))
    const tagsCall = seen.find((s) => s.url.includes('/api/tags'))
    expect(modelsCall?.auth).toBe('Bearer test-ollama-key')
    expect(tagsCall?.auth).toBe('Bearer test-ollama-key')
    expect(seen.every((s) => !s.url.includes('/v1/v1'))).toBe(true)
  })

  it('rejects cloud catalog without an API key', async () => {
    await expect(
      ollamaProvider.listModels({
        baseUrl: 'https://ollama.com',
        signal: AbortSignal.timeout(2000)
      })
    ).rejects.toThrow(/Ollama Cloud API key not set/i)
  })

  it('does not send Authorization for local Ollama without a key', async () => {
    const seen: Array<{ url: string; auth?: string }> = []
    setPublicFetchForTests(async (url, _addresses, _signal, headers) => {
      seen.push({ url: url.href, auth: headers?.Authorization })
      if (url.pathname.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen2.5' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('not found', { status: 404 })
    })

    await ollamaProvider.listModels({
      baseUrl: 'http://127.0.0.1:11434',
      signal: AbortSignal.timeout(2000)
    })

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => s.auth == null)).toBe(true)
  })

  it('normalizes baseUrl that already includes /v1', async () => {
    const seen: string[] = []
    setPublicFetchForTests(async (url) => {
      seen.push(url.href)
      if (url.pathname.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('not found', { status: 404 })
    })

    await ollamaProvider.listModels({
      baseUrl: 'http://127.0.0.1:11434/v1',
      signal: AbortSignal.timeout(2000)
    })

    expect(seen.some((u) => u.includes('/v1/v1'))).toBe(false)
    expect(seen.some((u) => u === 'http://127.0.0.1:11434/v1/models')).toBe(true)
    expect(seen.some((u) => u === 'http://127.0.0.1:11434/api/tags')).toBe(true)
  })
})
