import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildOpenAiCompatBody } from '@main/agent/providers/openai'
import { streamOpenAiResponses } from '@main/agent/providers/openaiResponses'
import { anthropicThinkingFields } from '@main/agent/providers/thinkingPolicy'
import type { ProviderChatRequest } from '@main/agent/providers/types'

const baseReq = (partial: Partial<ProviderChatRequest> = {}): ProviderChatRequest => ({
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
  apiKey: 'test',
  thinking: { enabled: true, effort: 'high' },
  ...partial
})

describe('openai compat thinking body', () => {
  it('adds DeepSeek thinking fields when enabled', () => {
    const body = buildOpenAiCompatBody(baseReq(), { defaultBaseUrl: 'https://api.deepseek.com/v1', deepseekThinking: true }, 'deepseek')
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
  })

  it('adds OpenRouter reasoning param when enabled', () => {
    const body = buildOpenAiCompatBody(
      baseReq({ model: 'anthropic/claude-sonnet-5' }),
      { defaultBaseUrl: 'https://openrouter.ai/api/v1', openRouterReasoning: true },
      'openrouter'
    )
    expect(body.reasoning).toEqual({ effort: 'high' })
  })

  it('replays reasoning_content on assistant tool-call messages', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        messages: [
          {
            role: 'assistant',
            content: '',
            thinking: 'internal',
            reasoningState: { kind: 'openai_compat', reasoningContent: 'internal' },
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
          }
        ]
      }),
      { defaultBaseUrl: 'https://api.deepseek.com/v1', deepseekThinking: true },
      'deepseek'
    )
    const assistant = (body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'assistant'
    )
    expect(assistant?.reasoning_content).toBe('internal')
  })

  it('adds Groq reasoning fields when enabled', () => {
    const body = buildOpenAiCompatBody(
      baseReq({ thinking: { enabled: true, effort: 'high', display: 'omitted' } }),
      { defaultBaseUrl: 'https://api.groq.com/openai/v1' },
      'groq'
    )
    expect(body.reasoning_effort).toBe('high')
    expect(body.reasoning_format).toBe('hidden')
    expect(body.include_reasoning).toBeUndefined()
  })

  it('adds Groq include_reasoning when display is summarized', () => {
    const body = buildOpenAiCompatBody(
      baseReq({ thinking: { enabled: true, effort: 'medium', display: 'summarized' } }),
      { defaultBaseUrl: 'https://api.groq.com/openai/v1' },
      'groq'
    )
    expect(body.include_reasoning).toBe(true)
    expect(body.reasoning_format).toBeUndefined()
  })

  it('adds xAI reasoning_effort when enabled', () => {
    const body = buildOpenAiCompatBody(
      baseReq({ thinking: { enabled: true, effort: 'minimal' } }),
      { defaultBaseUrl: 'https://api.x.ai/v1' },
      'xai'
    )
    expect(body.reasoning_effort).toBe('low')
  })

  it('adds Ollama think flag when enabled', () => {
    const body = buildOpenAiCompatBody(
      baseReq(),
      { defaultBaseUrl: 'http://localhost:11434', ollamaVision: true },
      'ollama'
    )
    expect(body.think).toBe(true)
  })

  it('adds custom reasoning_effort when thinking enabled', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'gpt-oss-120b',
        thinking: { enabled: true, effort: 'high', display: 'summarized' }
      }),
      { defaultBaseUrl: 'http://127.0.0.1:8080/v1', allowLocal: true },
      'custom'
    )
    expect(body.reasoning_effort).toBe('high')
    expect(body.include_reasoning).toBe(true)
    expect(body.think).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
    expect(body.thinking).toBeUndefined()
  })

  it('routes custom DeepSeek V4 through native thinking body', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        thinking: { enabled: true, effort: 'high', display: 'summarized' }
      }),
      { defaultBaseUrl: 'https://api.deepinfra.com/v1/openai', allowLocal: false },
      'custom'
    )
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
    expect(body.include_reasoning).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
  })

  it('disables thinking on custom DeepSeek V4 when Think is off', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'deepseek-ai/DeepSeek-V4-Flash',
        thinking: { enabled: false }
      }),
      { defaultBaseUrl: 'https://api.deepinfra.com/v1/openai' },
      'custom'
    )
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.include_reasoning).toBeUndefined()
  })

  it('maps custom DeepSeek minimal effort to low like first-party', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'deepseek-r1',
        thinking: { enabled: true, effort: 'minimal' }
      }),
      { defaultBaseUrl: 'https://api.deepinfra.com/v1/openai' },
      'custom'
    )
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('low')
  })

  it('omits include_reasoning for custom when display is omitted', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'gpt-oss-120b',
        thinking: { enabled: true, effort: 'medium', display: 'omitted' }
      }),
      { defaultBaseUrl: 'http://127.0.0.1:8080/v1', allowLocal: true },
      'custom'
    )
    expect(body.reasoning_effort).toBe('medium')
    expect(body.include_reasoning).toBeUndefined()
  })

  it('adds Mistral reasoning_effort when thinking enabled', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'mistral-small-latest',
        thinking: { enabled: true, effort: 'high', display: 'summarized' }
      }),
      { defaultBaseUrl: 'https://api.mistral.ai/v1', includeUsage: false },
      'mistral'
    )
    expect(body.reasoning_effort).toBe('high')
    expect(body.include_reasoning).toBeUndefined()
    expect(body.think).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
  })

  it('maps Mistral max effort to xhigh', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'mistral-medium-3-5',
        thinking: { enabled: true, effort: 'max' }
      }),
      { defaultBaseUrl: 'https://api.mistral.ai/v1', includeUsage: false },
      'mistral'
    )
    expect(body.reasoning_effort).toBe('xhigh')
  })

  it('sends Mistral reasoning_effort none when thinking is off', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'mistral-small-latest',
        thinking: { enabled: false },
        modelInfo: {
          id: 'mistral-small-latest',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: true,
          thinkingCanDisable: true
        }
      }),
      { defaultBaseUrl: 'https://api.mistral.ai/v1', includeUsage: false },
      'mistral'
    )
    expect(body.reasoning_effort).toBe('none')
  })

  it('strips reasoning replay for custom when display is omitted', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'gpt-oss-120b',
        thinking: { enabled: true, effort: 'high', display: 'omitted' },
        messages: [
          {
            role: 'assistant',
            content: '',
            thinking: 'internal',
            reasoningState: { kind: 'openai_compat', reasoningContent: 'internal' },
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
          }
        ]
      }),
      { defaultBaseUrl: 'http://127.0.0.1:8080/v1', allowLocal: true },
      'custom'
    )
    const assistant = (body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'assistant'
    )
    expect(assistant?.reasoning_content).toBeUndefined()
    expect(Array.isArray(assistant?.content)).toBe(false)
  })

  it('replays Mistral reasoning as ThinkChunk content, not reasoning_content', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'mistral-medium-3-5',
        thinking: { enabled: true, effort: 'high' },
        messages: [
          {
            role: 'assistant',
            content: 'The product is 391.',
            thinking: '17*23 = 391',
            reasoningState: {
              kind: 'openai_compat',
              reasoningContent: '17*23 = 391',
              reasoningFormat: 'think_chunks'
            }
          },
          { role: 'user', content: 'Now multiply that by 3.' }
        ]
      }),
      { defaultBaseUrl: 'https://api.mistral.ai/v1', includeUsage: false },
      'mistral'
    )
    const assistant = (body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'assistant'
    )
    expect(assistant?.reasoning_content).toBeUndefined()
    expect(assistant?.content).toEqual([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: '17*23 = 391' }],
        closed: true
      },
      { type: 'text', text: 'The product is 391.' }
    ])
  })

  it('replays stored multi-chunk ThinkChunks with signatures', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'mistral-medium-3-5',
        thinking: { enabled: true, effort: 'high' },
        messages: [
          {
            role: 'assistant',
            content: 'done',
            thinking: 'First.Second.',
            reasoningState: {
              kind: 'openai_compat',
              reasoningContent: 'First.Second.',
              reasoningFormat: 'think_chunks',
              thinkChunks: [
                { text: 'First.', signature: 'sig-1', closed: true },
                { text: 'Second.', signature: 'sig-2', closed: true }
              ]
            }
          },
          { role: 'user', content: 'continue' }
        ]
      }),
      { defaultBaseUrl: 'https://api.mistral.ai/v1', includeUsage: false },
      'mistral'
    )
    const assistant = (body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'assistant'
    )
    expect(assistant?.reasoning_content).toBeUndefined()
    expect(assistant?.content).toEqual([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'First.' }],
        closed: true,
        signature: 'sig-1'
      },
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'Second.' }],
        closed: true,
        signature: 'sig-2'
      },
      { type: 'text', text: 'done' }
    ])
  })

  it('replays stored ThinkChunk inner parts without flattening', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'mistral-medium-3-5',
        thinking: { enabled: true, effort: 'high' },
        messages: [
          {
            role: 'assistant',
            content: 'done',
            thinking: 'See docs',
            reasoningState: {
              kind: 'openai_compat',
              reasoningContent: 'See docs',
              reasoningFormat: 'think_chunks',
              thinkChunks: [
                {
                  text: 'See docs',
                  closed: true,
                  thinking: [
                    { type: 'text', text: 'See ' },
                    {
                      type: 'tool_reference',
                      tool: 'web_search',
                      title: 'Docs',
                      url: 'https://example.com'
                    },
                    { type: 'text', text: 'docs' }
                  ]
                }
              ]
            }
          },
          { role: 'user', content: 'continue' }
        ]
      }),
      { defaultBaseUrl: 'https://api.mistral.ai/v1', includeUsage: false },
      'mistral'
    )
    const assistant = (body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'assistant'
    )
    expect(assistant?.content).toEqual([
      {
        type: 'thinking',
        thinking: [
          { type: 'text', text: 'See ' },
          {
            type: 'tool_reference',
            tool: 'web_search',
            title: 'Docs',
            url: 'https://example.com'
          },
          { type: 'text', text: 'docs' }
        ],
        closed: true
      },
      { type: 'text', text: 'done' }
    ])
  })

  it('replays Mistral ThinkChunks on tool-call assistant turns', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'mistral-small-latest',
        thinking: { enabled: true, effort: 'high' },
        messages: [
          {
            role: 'assistant',
            content: '',
            thinking: 'Need the file.',
            reasoningState: { kind: 'openai_compat', reasoningContent: 'Need the file.' },
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
          }
        ]
      }),
      { defaultBaseUrl: 'https://api.mistral.ai/v1', includeUsage: false },
      'mistral'
    )
    const assistant = (body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'assistant'
    )
    expect(assistant?.reasoning_content).toBeUndefined()
    expect(assistant?.content).toEqual([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'Need the file.' }],
        closed: true
      }
    ])
    expect(assistant?.tool_calls).toHaveLength(1)
  })

  it('replays ThinkChunks for custom when stored format is think_chunks', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'local-mistral-clone',
        thinking: { enabled: true, effort: 'high', display: 'summarized' },
        messages: [
          {
            role: 'assistant',
            content: 'ok',
            thinking: 'plan',
            reasoningState: {
              kind: 'openai_compat',
              reasoningContent: 'plan',
              reasoningFormat: 'think_chunks'
            }
          }
        ]
      }),
      { defaultBaseUrl: 'http://127.0.0.1:8080/v1', allowLocal: true },
      'custom'
    )
    const assistant = (body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'assistant'
    )
    expect(assistant?.reasoning_content).toBeUndefined()
    expect(assistant?.content).toEqual([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'plan' }],
        closed: true
      },
      { type: 'text', text: 'ok' }
    ])
  })

  it('keeps reasoning_content for custom when format is not think_chunks', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'gpt-oss-120b',
        thinking: { enabled: true, effort: 'high', display: 'summarized' },
        messages: [
          {
            role: 'assistant',
            content: 'ok',
            thinking: 'plan',
            reasoningState: {
              kind: 'openai_compat',
              reasoningContent: 'plan',
              reasoningFormat: 'reasoning_content'
            }
          }
        ]
      }),
      { defaultBaseUrl: 'http://127.0.0.1:8080/v1', allowLocal: true },
      'custom'
    )
    const assistant = (body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'assistant'
    )
    expect(assistant?.reasoning_content).toBe('plan')
    expect(assistant?.content).toBe('ok')
  })

  it('strips reasoning replay for OpenRouter', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'anthropic/claude-sonnet-5',
        thinking: { enabled: true, effort: 'high' },
        messages: [
          {
            role: 'assistant',
            content: 'hi',
            thinking: 'secret',
            reasoningState: { kind: 'openai_compat', reasoningContent: 'secret' }
          }
        ]
      }),
      { defaultBaseUrl: 'https://openrouter.ai/api/v1', openRouterReasoning: true },
      'openrouter'
    )
    const assistant = (body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === 'assistant'
    )
    expect(assistant?.reasoning_content).toBeUndefined()
    expect(assistant?.content).toBe('hi')
  })

  it('sends Ollama gpt-oss think levels instead of boolean', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'gpt-oss:120b-cloud',
        thinking: { enabled: true, effort: 'high' },
        modelInfo: {
          id: 'gpt-oss:120b-cloud',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: true,
          thinkingMode: 'effort',
          thinkingCanDisable: false,
          supportedThinkingEfforts: ['low', 'medium', 'high']
        }
      }),
      { defaultBaseUrl: 'https://ollama.com', ollamaVision: true },
      'ollama'
    )
    expect(body.think).toBe('high')
  })

  it('normalizes DeepSeek effort values', () => {
    const body = buildOpenAiCompatBody(
      baseReq({ thinking: { enabled: true, effort: 'minimal' } }),
      { defaultBaseUrl: 'https://api.deepseek.com/v1', deepseekThinking: true },
      'deepseek'
    )
    expect(body.reasoning_effort).toBe('low')
  })

  it('sends OpenRouter reasoning.effort none when thinking is off', () => {
    const body = buildOpenAiCompatBody(
      baseReq({
        model: 'anthropic/claude-sonnet-5',
        thinking: { enabled: false },
        modelInfo: {
          id: 'anthropic/claude-sonnet-5',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: true,
          thinkingCanDisable: true
        }
      }),
      { defaultBaseUrl: 'https://openrouter.ai/api/v1', openRouterReasoning: true },
      'openrouter'
    )
    expect(body.reasoning).toEqual({ effort: 'none' })
  })

  it('sets Ollama think false when thinking is off', () => {
    const body = buildOpenAiCompatBody(
      baseReq({ thinking: { enabled: false } }),
      { defaultBaseUrl: 'http://localhost:11434', ollamaVision: true },
      'ollama'
    )
    expect(body.think).toBe(false)
  })
})

describe('openai responses thinking off', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends reasoning.effort none when thinking is disabled', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const gen = streamOpenAiResponses(
      baseReq({
        model: 'gpt-5.6',
        thinking: { enabled: false },
        modelInfo: {
          id: 'gpt-5.6',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: true
        }
      })
    )
    for await (const _ of gen) {
      /* drain */
    }

    expect(fetchMock).toHaveBeenCalled()
    const init = fetchMock.mock.calls[0]?.[1] as { body?: string }
    const body = JSON.parse(init.body ?? '{}') as { reasoning?: { effort?: string } }
    expect(body.reasoning?.effort).toBe('none')
  })
})

describe('anthropic thinking fields', () => {
  it('uses adaptive thinking on Sonnet 5', () => {
    const fields = anthropicThinkingFields(
      baseReq({ model: 'claude-sonnet-5', thinking: { enabled: true, effort: 'high' } })
    )
    expect(fields.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(fields.output_config).toEqual({ effort: 'high' })
  })

  it('uses adaptive thinking on Sonnet 4.6', () => {
    const fields = anthropicThinkingFields(
      baseReq({ model: 'claude-sonnet-4-6', thinking: { enabled: true, effort: 'medium' } })
    )
    expect(fields.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(fields.output_config).toEqual({ effort: 'medium' })
  })

  it('maps minimal effort to low on Anthropic adaptive', () => {
    const fields = anthropicThinkingFields(
      baseReq({ model: 'claude-opus-4-7', thinking: { enabled: true, effort: 'minimal' } })
    )
    expect(fields.output_config).toEqual({ effort: 'low' })
  })

  it('disables thinking explicitly on adaptive models when off', () => {
    const fields = anthropicThinkingFields(
      baseReq({ model: 'claude-sonnet-4-6', thinking: { enabled: false } })
    )
    expect(fields.thinking).toEqual({ type: 'disabled' })
  })

  it('uses manual budget on older Claude models', () => {
    const fields = anthropicThinkingFields(
      baseReq({
        model: 'claude-sonnet-4-5',
        thinking: { enabled: true, effort: 'high' }
      })
    )
    expect(fields.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 })
  })
})
