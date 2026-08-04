import { describe, expect, it } from 'vitest'
import { resolveEffectiveSettings } from '@shared/effectiveSettings'
import { DEFAULT_SETTINGS } from '@shared/ipc'

describe('resolveEffectiveSettings', () => {
  it('returns global chat settings when override is off', () => {
    const effective = resolveEffectiveSettings(DEFAULT_SETTINGS, {
      useOverride: false,
      provider: 'openai',
      model: 'gpt-5.6',
      thinkingEffort: 'max'
    })
    expect(effective.provider).toBe(DEFAULT_SETTINGS.provider)
    expect(effective.model).toBe(DEFAULT_SETTINGS.model)
    expect(effective.thinkingEffort).toBe(DEFAULT_SETTINGS.thinkingEffort)
    expect(effective.thinkingEnabled).toBe(DEFAULT_SETTINGS.thinkingEnabled)
  })

  it('merges thinking and agent fields from workspace override', () => {
    const effective = resolveEffectiveSettings(DEFAULT_SETTINGS, {
      useOverride: true,
      provider: 'openai',
      model: 'gpt-5.6',
      thinkingEnabled: false,
      thinkingEffort: 'high',
      showThinking: false,
      compactionTriggerRatio: 0.85,
      keepRecentTurns: 20
    })
    expect(effective).toEqual({
      provider: 'openai',
      model: 'gpt-5.6',
      ollamaBaseUrl: DEFAULT_SETTINGS.ollamaBaseUrl,
      customOpenAiBaseUrl: DEFAULT_SETTINGS.customOpenAiBaseUrl,
      thinkingEnabled: false,
      thinkingEffort: 'high',
      showThinking: false,
      compactionTriggerRatio: 0.85,
      keepRecentTurns: 20,
      toolApproval: DEFAULT_SETTINGS.toolApproval
    })
  })
})
