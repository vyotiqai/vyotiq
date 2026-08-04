import { describe, expect, it } from 'vitest'
import {
  knownContextWindow,
  withResolvedContextWindow
} from '@shared/domain/modelContextWindows'
import { seedModelsFor } from '@shared/providers'
import { contentWindow, contextWindowFor } from '@main/agent/context/budget'

describe('knownContextWindow', () => {
  it('returns 1M for DeepSeek V4 models and legacy aliases', () => {
    expect(knownContextWindow('deepseek-v4-flash', 'deepseek')).toBe(1_000_000)
    expect(knownContextWindow('deepseek-v4-pro', 'deepseek')).toBe(1_000_000)
    expect(knownContextWindow('deepseek-chat', 'deepseek')).toBe(1_000_000)
    expect(knownContextWindow('deepseek-reasoner', 'deepseek')).toBe(1_000_000)
    expect(knownContextWindow('deepseek/deepseek-v4-flash', 'openrouter')).toBe(1_000_000)
  })

  it('returns 1.05M-class windows for GPT-5.6 and Gemini 3', () => {
    expect(knownContextWindow('gpt-5.6', 'openai')).toBe(1_048_576)
    expect(knownContextWindow('gpt-5.6-terra', 'openai')).toBe(1_048_576)
    expect(knownContextWindow('gemini-3.6-flash', 'gemini')).toBe(1_048_576)
    expect(knownContextWindow('grok-4-latest', 'xai')).toBe(1_000_000)
  })

  it('backfills missing contextWindow without overriding larger API values', () => {
    const missing = withResolvedContextWindow(
      {
        id: 'deepseek-v4-flash',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      },
      'deepseek'
    )
    expect(missing.contextWindow).toBe(1_000_000)

    const bogusDefault = withResolvedContextWindow(
      {
        id: 'deepseek-v4-flash',
        contextWindow: 128_000,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      },
      'deepseek'
    )
    expect(bogusDefault.contextWindow).toBe(1_000_000)

    const kept = withResolvedContextWindow(
      {
        id: 'deepseek-v4-flash',
        contextWindow: 2_000_000,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      },
      'deepseek'
    )
    expect(kept.contextWindow).toBe(2_000_000)
  })
})

describe('DeepSeek seed + budget', () => {
  it('seeds V4 models with 1M windows', () => {
    const seeds = seedModelsFor('deepseek')
    expect(seeds.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(seeds.find((m) => m.id === 'deepseek-v4-flash')?.contextWindow).toBe(1_000_000)
  })

  it('uses known window when ModelInfo omits contextWindow', () => {
    const model = {
      id: 'deepseek-v4-pro',
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      supportsTools: true,
      supportsVision: false
    }
    expect(contextWindowFor(model)).toBe(1_000_000)
    // content budget is non-buffer shares (85%), not a second buffer subtract
    expect(contentWindow(model)).toBe(850_000)
  })
})
