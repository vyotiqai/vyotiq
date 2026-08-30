import { describe, expect, it, beforeAll } from 'vitest'
import { ProviderIdSchema } from '@shared/ipc/schemas/providers'
import type { ModelInfo } from '@shared/ipc'
import { seedModelsFor } from '@shared/providers'
import {
  opencodeGoTransportFor,
  loadOpenCodeGoCatalog,
  preloadOpenCodeGoCatalog
} from '@shared/domain/opencodeGoCatalog'
import { PUBLIC_CATALOG_PROVIDERS, getProvider } from '@main/agent/providers'
import { mergeGoMeta, opencodeEndpointFor } from '@main/agent/providers/opencode'

// Endpoints table from https://opencode.ai/docs/go/ — structural routing only.
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

// Resolve the live models.dev `opencode-go` registry before any assertion that
// depends on runtime-fetched metadata (context windows, effort ladders).
beforeAll(async () => {
  await loadOpenCodeGoCatalog()
})

describe('OpenCode Go (opencode) provider wiring', () => {
  it('is a recognized provider id', () => {
    expect(ProviderIdSchema.safeParse('opencode').success).toBe(true)
  })

  it('seeds with the live registry model ids, all bare (no opencode-go/ prefix)', async () => {
    const state = await loadOpenCodeGoCatalog()
    const liveIds = [...state.models.keys()].sort()
    const models = seedModelsFor('opencode')
    // Seeds are sourced from the same live registry — every live id is seeded.
    expect(models.length).toBe(liveIds.length)
    expect(models.map((m) => m.id).sort()).toEqual(liveIds)
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

  it('defaults every other routed model to chat completions', () => {
    const routed = new Set([...RESPONSES_ENDPOINT_MODELS, ...MESSAGES_ENDPOINT_MODELS])
    for (const id of [...routed].length ? [] : []) void id // (kept for clarity)
    // Spot-check documented chat models route to chat.
    for (const id of ['kimi-k3', 'glm-5.2', 'deepseek-v4-pro', 'hy3', 'longcat-2.0']) {
      expect(opencodeEndpointFor(id)).toBe('chat')
    }
  })

  it('routes live-catalog-only ids by their documented family', () => {
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
    expect(glm.supportedThinkingEfforts).toEqual(['high', 'max'])
    expect(glm.thinkingCanDisable).toBe(false)

    const glm53 = models.get('glm-5.3')!
    expect(glm53.thinkingApi).toBe('chat_completions')
    expect(glm53.supportedThinkingEfforts).toEqual(['low', 'high', 'max'])
    expect(glm53.thinkingCanDisable).toBe(false)

    // Registry marks every Go model reasoning-capable — even non-family ids.
    for (const id of ['longcat-2.0', 'hy3', 'mimo-v2.5', 'ox-alpha-free']) {
      const m = models.get(id)!
      expect(m.supportsThinking).toBe(true)
      expect(m.supportedThinkingEfforts?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('clamps live catalog rows to the registry ladder and marks disable unsupported', async () => {
    const live: ModelInfo = {
      id: 'opencode-go/glm-5.3-flash',
      displayName: 'GLM-5.3-Flash (2x usage)',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsVision: false,
      supportsThinking: true,
      thinkingApi: 'chat_completions',
      thinkingMode: 'effort',
      thinkingCanDisable: true,
      supportedThinkingEfforts: ['low', 'medium', 'high']
    }
    const merged = await mergeGoMeta(live)
    expect(merged.id).toBe('glm-5.3-flash')
    expect(merged.supportedThinkingEfforts).toEqual(['low', 'high', 'max'])
    expect(merged.thinkingCanDisable).toBe(false)
    // No declared ladder → row metadata passes through untouched.
    const glm5 = await mergeGoMeta({ ...live, id: 'glm-5' })
    expect(glm5.supportedThinkingEfforts).toEqual(['low', 'medium', 'high'])
    expect(glm5.thinkingCanDisable).toBe(true)
  })
})
