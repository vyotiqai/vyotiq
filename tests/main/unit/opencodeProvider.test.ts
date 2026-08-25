import { describe, expect, it } from 'vitest'
import { ProviderIdSchema } from '@shared/ipc/schemas/providers'
import { seedModelsFor } from '@shared/providers'
import { opencodeGoTransportFor } from '@shared/domain/opencodeGoModels'
import { PUBLIC_CATALOG_PROVIDERS, getProvider } from '@main/agent/providers'
import { opencodeEndpointFor } from '@main/agent/providers/opencode'

const DOCUMENTED_MODELS = new Set([
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'longcat-2.0',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'hy3',
  'ox-alpha-free',
  'grok-4.5',
  'gpt-5.6-luna',
  'muse-spark-1.2-contributor',
  'minimax-m3',
  'minimax-m2.7',
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus'
])

// https://opencode.ai/docs/go/ — Endpoints table.
const RESPONSES_ENDPOINT_MODELS = ['grok-4.5', 'gpt-5.6-luna', 'muse-spark-1.2-contributor']
const MESSAGES_ENDPOINT_MODELS = [
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus'
]

describe('OpenCode Go (opencode) provider wiring', () => {
  it('is a recognized provider id', () => {
    expect(ProviderIdSchema.safeParse('opencode').success).toBe(true)
  })

  it('seeds exactly the documented Go model ids, all bare (no opencode-go/ prefix)', () => {
    const models = seedModelsFor('opencode')
    expect(models.map((m) => m.id).sort()).toEqual([...DOCUMENTED_MODELS].sort())
    for (const m of models) {
      expect(m.id).not.toMatch(/^opencode-go\//)
    }
  })

  it('routes Responses-API models to /responses', () => {
    for (const id of RESPONSES_ENDPOINT_MODELS) {
      expect(opencodeEndpointFor(id)).toBe('responses')
      expect(opencodeEndpointFor(`opencode-go/${id}`)).toBe('responses')
    }
  })

  it('routes Anthropic Messages models to /messages', () => {
    for (const id of MESSAGES_ENDPOINT_MODELS) {
      expect(opencodeEndpointFor(id)).toBe('messages')
      expect(opencodeEndpointFor(`opencode-go/${id}`)).toBe('messages')
    }
  })

  it('defaults every other documented model to chat completions', () => {
    const routed = new Set([...RESPONSES_ENDPOINT_MODELS, ...MESSAGES_ENDPOINT_MODELS])
    for (const id of DOCUMENTED_MODELS) {
      if (routed.has(id)) continue
      expect(opencodeEndpointFor(id)).toBe('chat')
    }
  })

  it('routes live-catalog-only ids by their documented family', () => {
    // Live /v1/models also serves these ids (verified Aug 2026).
    expect(opencodeGoTransportFor('qwen3.5-plus')).toBe('messages')
    for (const id of ['kimi-k2.5', 'glm-5', 'mimo-v2-pro', 'mimo-v2-omni', 'hy3-preview']) {
      expect(opencodeGoTransportFor(id)).toBe('chat')
      expect(opencodeEndpointFor(id)).toBe('chat')
    }
  })

  it('is listed as a public (keyless) catalog provider', () => {
    expect(PUBLIC_CATALOG_PROVIDERS.has('opencode')).toBe(true)
    expect(getProvider('opencode').id).toBe('opencode')
  })

  it('backfills seeds with registry context/output windows and modalities', () => {
    const models = new Map(seedModelsFor('opencode').map((m) => [m.id, m]))
    const glm52 = models.get('glm-5.2')!
    expect(glm52.contextWindow).toBe(1_000_000)
    expect(glm52.maxOutputTokens).toBe(131_072)
    expect(models.get('kimi-k3')!.contextWindow).toBe(1_048_576)
    expect(models.get('hy3')!.contextWindow).toBe(256_000)
    expect(models.get('minimax-m3')!.maxOutputTokens).toBe(131_072)
    expect(models.get('deepseek-v4-pro')!.maxOutputTokens).toBe(384_000)
    expect(models.get('kimi-k3')!.inputModalities).toContain('image')
    expect(models.get('gpt-5.6-luna')!.inputModalities).toContain('file')
  })

  it('exposes thinking with transport-aware API and effort ladders on seeds', () => {
    const models = new Map(seedModelsFor('opencode').map((m) => [m.id, m]))
    const grok = models.get('grok-4.5')!
    expect(grok.supportsThinking).toBe(true)
    expect(grok.thinkingApi).toBe('responses')
    expect(grok.supportedThinkingEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])

    const minimax = models.get('minimax-m3')!
    expect(minimax.thinkingApi).toBe('messages')
    expect(minimax.supportedThinkingEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(minimax.thinkingMode).toBe('effort')

    const glm = models.get('glm-5.2')!
    expect(glm.thinkingApi).toBe('chat_completions')
    expect(glm.supportedThinkingEfforts).toEqual(['low', 'medium', 'high'])
    expect(glm.thinkingCanDisable).toBe(true)

    // Registry marks every Go model reasoning-capable — even non-family ids.
    for (const id of ['longcat-2.0', 'hy3', 'mimo-v2.5', 'ox-alpha-free']) {
      const m = models.get(id)!
      expect(m.supportsThinking).toBe(true)
      expect(m.supportedThinkingEfforts?.length ?? 0).toBeGreaterThan(0)
    }
  })
})
