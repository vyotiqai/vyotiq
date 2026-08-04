import { describe, expect, it } from 'vitest'
import {
  isOllamaCloudHost,
  normalizeCustomOpenAiBaseUrl,
  ollamaNativeHost,
  ollamaOpenAiBaseUrl,
  providerNeedsKey,
  resolveEffectiveOllamaHost,
  resolveOllamaListBaseUrl,
  resolveProviderChatBaseUrl,
  resolveProviderListBaseUrl
} from '@shared/domain/providers'

describe('ollama host helpers', () => {
  it('strips trailing /v1 so OpenAI base is never doubled', () => {
    expect(ollamaNativeHost('https://ollama.com/v1')).toBe('https://ollama.com')
    expect(ollamaNativeHost('https://ollama.com/v1/')).toBe('https://ollama.com')
    expect(ollamaNativeHost('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434')
    expect(ollamaOpenAiBaseUrl('https://ollama.com/v1')).toBe('https://ollama.com/v1')
    expect(resolveOllamaListBaseUrl('https://ollama.com/v1')).toBe('https://ollama.com')
  })

  it('detects Ollama Cloud hosts', () => {
    expect(isOllamaCloudHost('https://ollama.com')).toBe(true)
    expect(isOllamaCloudHost('https://ollama.com/v1')).toBe(true)
    expect(isOllamaCloudHost('https://api.ollama.com')).toBe(true)
    expect(isOllamaCloudHost('http://127.0.0.1:11434')).toBe(false)
    expect(isOllamaCloudHost('http://localhost:11434')).toBe(false)
  })

  it('requires a key only for Ollama Cloud', () => {
    expect(providerNeedsKey('openai')).toBe(true)
    expect(providerNeedsKey('ollama')).toBe(false)
    expect(providerNeedsKey('ollama', 'http://127.0.0.1:11434')).toBe(false)
    expect(providerNeedsKey('ollama', 'https://ollama.com')).toBe(true)
  })

  it('routes local hosts to Cloud when an API key is set', () => {
    expect(resolveEffectiveOllamaHost('http://127.0.0.1:11434', 'sk-test')).toBe(
      'https://ollama.com'
    )
    expect(resolveEffectiveOllamaHost('http://localhost:11434', 'sk-test')).toBe(
      'https://ollama.com'
    )
    expect(resolveEffectiveOllamaHost('http://127.0.0.1:11434', null)).toBe(
      'http://127.0.0.1:11434'
    )
    expect(resolveEffectiveOllamaHost('https://ollama.com', 'sk-test')).toBe('https://ollama.com')
    expect(resolveEffectiveOllamaHost('http://192.168.1.10:11434', 'sk-test')).toBe(
      'http://192.168.1.10:11434'
    )
  })
})

describe('custom OpenAI-compatible host helpers', () => {
  it('normalizes custom base URLs to an OpenAI /v1 mount without doubling', () => {
    expect(normalizeCustomOpenAiBaseUrl('http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/v1'
    )
    expect(normalizeCustomOpenAiBaseUrl('https://api.fireworks.ai/inference/v1')).toBe(
      'https://api.fireworks.ai/inference/v1'
    )
    expect(normalizeCustomOpenAiBaseUrl('https://api.fireworks.ai/inference/v1/')).toBe(
      'https://api.fireworks.ai/inference/v1'
    )
    // Vendor suffix after /v1 (DeepInfra OpenAI-compat mount).
    expect(normalizeCustomOpenAiBaseUrl('https://api.deepinfra.com/v1/openai')).toBe(
      'https://api.deepinfra.com/v1/openai'
    )
    expect(normalizeCustomOpenAiBaseUrl('https://api.deepinfra.com/v1/openai/')).toBe(
      'https://api.deepinfra.com/v1/openai'
    )
    // Repair corrupted saves from older “must end with /v1” normalizer.
    expect(normalizeCustomOpenAiBaseUrl('https://api.deepinfra.com/v1/openai/v1')).toBe(
      'https://api.deepinfra.com/v1/openai'
    )
    expect(normalizeCustomOpenAiBaseUrl('https://api.groq.com/openai/v1')).toBe(
      'https://api.groq.com/openai/v1'
    )
  })

  it('requires a key for remote custom hosts but not local or private LAN ones', () => {
    expect(providerNeedsKey('custom', 'http://127.0.0.1:8080/v1')).toBe(false)
    expect(providerNeedsKey('custom', 'http://localhost:8080/v1')).toBe(false)
    expect(providerNeedsKey('custom', 'http://192.168.1.10:8000/v1')).toBe(false)
    expect(providerNeedsKey('custom', 'http://10.0.0.5:8080/v1')).toBe(false)
    expect(providerNeedsKey('custom', 'http://172.16.4.2:8080/v1')).toBe(false)
    expect(providerNeedsKey('custom', 'https://api.fireworks.ai/inference/v1')).toBe(true)
    expect(providerNeedsKey('custom', 'https://api.deepinfra.com/v1/openai')).toBe(true)
  })

  it('resolves chat and list base URLs for custom', () => {
    expect(
      resolveProviderChatBaseUrl('custom', {
        customOpenAiBaseUrl: 'http://127.0.0.1:9000'
      })
    ).toBe('http://127.0.0.1:9000/v1')
    expect(
      resolveProviderListBaseUrl('custom', undefined, {
        customOpenAiBaseUrl: 'https://api.together.xyz'
      })
    ).toBe('https://api.together.xyz/v1')
    expect(
      resolveProviderChatBaseUrl('custom', {
        customOpenAiBaseUrl: 'https://api.deepinfra.com/v1/openai'
      })
    ).toBe('https://api.deepinfra.com/v1/openai')
    expect(
      resolveProviderListBaseUrl('custom', undefined, {
        customOpenAiBaseUrl: 'https://api.deepinfra.com/v1/openai/v1'
      })
    ).toBe('https://api.deepinfra.com/v1/openai')
  })
})
