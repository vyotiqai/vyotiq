import { describe, expect, it } from 'vitest'
import { ProviderIdSchema } from '@shared/ipc/schemas/providers'
import { SECRET_PROVIDERS, emptySecretStatus } from '@shared/ipc'
import { PROVIDER_DEFAULTS, seedModelsFor } from '@shared/providers'
import {
  isProviderConfigured,
  providerNeedsKey,
  resolveProviderChatBaseUrl,
  resolveProviderListBaseUrl
} from '@shared/domain/providers'
import { getProvider } from '@main/agent/providers'
import {
  MODAL_OPTS,
  buildOpenAiCompatBody
} from '@main/agent/providers/openai'
import { requestMaxOutputTokens } from '@main/agent/providers/requestLimits'

describe('Modal (modal) provider wiring', () => {
  it('is a recognized provider id and secret slot', () => {
    expect(ProviderIdSchema.safeParse('modal').success).toBe(true)
    expect(SECRET_PROVIDERS).toContain('modal')
    const entry = PROVIDER_DEFAULTS.find((p) => p.id === 'modal')
    expect(entry?.label).toBe('Modal')
  })

  it('always requires an API key (cloud Shared Endpoints host)', () => {
    expect(providerNeedsKey('modal')).toBe(true)
    expect(providerNeedsKey('modal', 'https://inference.us-west.modal.direct/v1')).toBe(true)
    const secrets = emptySecretStatus()
    expect(isProviderConfigured('modal', secrets)).toBe(false)
    secrets.modal = true
    expect(isProviderConfigured('modal', secrets)).toBe(true)
  })

  it('uses the fixed region-scoped base URL (no configurable host)', () => {
    expect(resolveProviderChatBaseUrl('modal', {})).toBeUndefined()
    expect(resolveProviderChatBaseUrl('modal', {}, 'wk-1.ws-2')).toBeUndefined()
    expect(resolveProviderListBaseUrl('modal', undefined, {})).toBeUndefined()
    expect(MODAL_OPTS.defaultBaseUrl).toBe('https://inference.us-west.modal.direct/v1')
  })

  it('seeds one illustrative endpoint-hostname placeholder until the live catalog loads', () => {
    const seeds = seedModelsFor('modal')
    expect(seeds.map((m) => m.id)).toEqual(['my-endpoint.us-west.modal.direct'])
    for (const m of seeds) {
      expect(m.isPlaceholder).toBe(true)
      expect(m.supportsTools).toBe(true)
    }
  })

  it('registers a chat/list provider in the runtime registry', () => {
    const provider = getProvider('modal')
    expect(provider.id).toBe('modal')
    expect(typeof provider.streamChat).toBe('function')
    expect(typeof provider.listModels).toBe('function')
  })

  it('sends the widest OpenAI-compat reasoning shape on chat bodies', () => {
    const body = buildOpenAiCompatBody(
      {
        model: 'my-endpoint.us-west.modal.direct',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
        thinking: { enabled: true, effort: 'xhigh', display: 'summarized' }
      },
      MODAL_OPTS,
      'modal'
    )
    expect(body.reasoning_effort).toBe('high')
    expect(body.include_reasoning).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('omits max_tokens like the other OpenAI-compat gateways (no credit reservation)', () => {
    expect(requestMaxOutputTokens('modal', { maxOutputTokens: 65_536 })).toBeUndefined()
    const body = buildOpenAiCompatBody(
      {
        model: 'my-endpoint.us-west.modal.direct',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
        maxOutputTokens: 65_536
      },
      MODAL_OPTS,
      'modal'
    )
    // When a caller sends an explicit maxOutputTokens anyway, the body honors it.
    expect(body.max_tokens).toBe(65_536)
  })
})
