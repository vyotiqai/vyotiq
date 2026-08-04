import { describe, expect, it } from 'vitest'
import { resolveImageReadyLabel } from '@shared/domain/imageCapability'

describe('resolveImageReadyLabel', () => {
  it('returns null when no image keys exist', () => {
    expect(
      resolveImageReadyLabel({
        imageProvider: 'auto',
        secrets: { openai: false, gemini: false, xai: false, openrouter: false, custom: false }
      })
    ).toBeNull()
  })

  it('prefers auto priority OpenAI when present', () => {
    expect(
      resolveImageReadyLabel({
        imageProvider: 'auto',
        secrets: { openai: true, gemini: true, xai: false, openrouter: true },
        customImageEnabled: true
      })
    ).toBe('Image ready: OpenAI')
  })

  it('falls back to OpenRouter when only that key exists', () => {
    expect(
      resolveImageReadyLabel({
        imageProvider: 'auto',
        secrets: { openai: false, gemini: false, xai: false, openrouter: true }
      })
    ).toBe('Image ready: OpenRouter')
  })

  it('ignores custom key until enabled', () => {
    expect(
      resolveImageReadyLabel({
        imageProvider: 'auto',
        secrets: { custom: true },
        customImageEnabled: false
      })
    ).toBeNull()
    expect(
      resolveImageReadyLabel({
        imageProvider: 'auto',
        secrets: { custom: true },
        customImageEnabled: true
      })
    ).toBe('Image ready: Custom')
  })

  it('treats keyless private/LAN custom as ready when images enabled', () => {
    expect(
      resolveImageReadyLabel({
        imageProvider: 'custom',
        secrets: { custom: false },
        customImageEnabled: true,
        customOpenAiBaseUrl: 'http://192.168.1.20:8080/v1'
      })
    ).toBe('Image ready: Custom')
    expect(
      resolveImageReadyLabel({
        imageProvider: 'custom',
        secrets: { custom: false },
        customImageEnabled: true,
        customOpenAiBaseUrl: 'https://api.fireworks.ai/inference/v1'
      })
    ).toBeNull()
  })

  it('uses caller-supplied customOpenAiBaseUrl for keyless readiness (effective/workspace)', () => {
    expect(
      resolveImageReadyLabel({
        imageProvider: 'custom',
        secrets: { custom: false },
        customImageEnabled: true,
        customOpenAiBaseUrl: 'http://10.0.0.8:8000/v1'
      })
    ).toBe('Image ready: Custom')
  })

  it('honors explicit image provider when key exists', () => {
    expect(
      resolveImageReadyLabel({
        imageProvider: 'gemini',
        secrets: { openai: true, gemini: true, xai: false }
      })
    ).toBe('Image ready: Gemini')
    expect(
      resolveImageReadyLabel({
        imageProvider: 'openrouter',
        secrets: { openrouter: true }
      })
    ).toBe('Image ready: OpenRouter')
  })

  it('returns null when explicit provider key is missing', () => {
    expect(
      resolveImageReadyLabel({
        imageProvider: 'xai',
        secrets: { openai: true, gemini: false, xai: false }
      })
    ).toBeNull()
  })
})
