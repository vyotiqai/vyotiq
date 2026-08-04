import { describe, expect, it } from 'vitest'
import {
  compatStreamOptions,
  buildOpenAiCompatBody,
  openAiCompatMessageReasoningDelta,
  parseOpenAiCompatDeltaContent,
  parseOpenAiCompatUsage,
  toOpenAiCompatThinkChunkContent,
  absorbOpenAiCompatThinkChunks
} from '@main/agent/providers/openai'
import type { ProviderChatRequest } from '@main/agent/providers/types'

describe('compatStreamOptions', () => {
  it('includes usage by default', () => {
    expect(compatStreamOptions({ defaultBaseUrl: 'https://api.openai.com/v1' })).toEqual({
      stream_options: { include_usage: true }
    })
  })

  it('omits stream_options for Mistral and Ollama', () => {
    expect(
      compatStreamOptions({ defaultBaseUrl: 'https://api.mistral.ai/v1', includeUsage: false })
    ).toEqual({})
    expect(
      compatStreamOptions({ defaultBaseUrl: 'http://127.0.0.1:11434/v1', ollamaVision: true })
    ).toEqual({})
  })
})

describe('buildOpenAiCompatBody prompt cache', () => {
  const baseReq: ProviderChatRequest = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal
  }

  it('omits max_tokens when maxOutputTokens is unset', () => {
    const body = buildOpenAiCompatBody(baseReq, { defaultBaseUrl: 'https://openrouter.ai/api/v1' })
    expect(body.max_tokens).toBeUndefined()
  })

  it('includes max_tokens only when explicitly set on the request', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, maxOutputTokens: 4096 },
      { defaultBaseUrl: 'https://openrouter.ai/api/v1' }
    )
    expect(body.max_tokens).toBe(4096)
  })

  it('includes prompt_cache_key when enabled for OpenAI', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, promptCacheKey: 'run-abc' },
      { defaultBaseUrl: 'https://api.openai.com/v1', enablePromptCache: true }
    )
    expect(body.prompt_cache_key).toBe('run-abc')
  })

  it('omits prompt_cache_key for providers without enablePromptCache', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, promptCacheKey: 'run-abc' },
      { defaultBaseUrl: 'https://api.groq.com/openai/v1' }
    )
    expect(body.prompt_cache_key).toBeUndefined()
  })

  it('omits prompt_cache_key for DeepSeek (automatic prefix cache only)', () => {
    const body = buildOpenAiCompatBody(
      { ...baseReq, promptCacheKey: 'run-abc' },
      { defaultBaseUrl: 'https://api.deepseek.com/v1' }
    )
    expect(body.prompt_cache_key).toBeUndefined()
  })
})

describe('parseOpenAiCompatUsage cache metrics', () => {
  it('reads DeepSeek prompt_cache_hit_tokens', () => {
    const usage = parseOpenAiCompatUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100
    })
    expect(usage?.cachedInputTokens).toBe(900)
    expect(usage?.inputTokens).toBe(1000)
  })

  it('reads Groq/OpenAI prompt_tokens_details.cached_tokens', () => {
    const usage = parseOpenAiCompatUsage({
      prompt_tokens: 500,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 400 }
    })
    expect(usage?.cachedInputTokens).toBe(400)
  })

  it('returns undefined for empty usage payloads', () => {
    expect(parseOpenAiCompatUsage(null)).toBeUndefined()
    expect(parseOpenAiCompatUsage({})).toBeUndefined()
  })
})

describe('openAiCompatMessageReasoningDelta', () => {
  it('emits the full message when no reasoning streamed yet', () => {
    expect(openAiCompatMessageReasoningDelta('Plan the audit.', '')).toBe('Plan the audit.')
  })

  it('emits only the new suffix when message extends streamed reasoning', () => {
    expect(openAiCompatMessageReasoningDelta('Plan the audit. Start with src.', 'Plan the audit.')).toBe(
      ' Start with src.'
    )
  })

  it('returns null when message does not extend accumulated reasoning', () => {
    expect(openAiCompatMessageReasoningDelta('Plan the audit.', 'Plan the audit.')).toBeNull()
  })
})

describe('parseOpenAiCompatDeltaContent ThinkChunk', () => {
  it('keeps plain string content as text', () => {
    expect(parseOpenAiCompatDeltaContent('Hello')).toEqual({
      text: 'Hello',
      reasoning: null,
      thinkChunks: null
    })
    expect(parseOpenAiCompatDeltaContent('')).toEqual({
      text: null,
      reasoning: null,
      thinkChunks: null
    })
  })

  it('extracts Mistral ThinkChunk reasoning and TextChunk answer', () => {
    expect(
      parseOpenAiCompatDeltaContent([
        {
          type: 'thinking',
          thinking: [{ type: 'text', text: '17*23 = ' }, { type: 'text', text: '391' }]
        },
        { type: 'text', text: 'The product is 391.' }
      ])
    ).toEqual({
      text: 'The product is 391.',
      reasoning: '17*23 = 391',
      thinkChunks: [
        {
          text: '17*23 = 391',
          thinking: [
            { type: 'text', text: '17*23 = ' },
            { type: 'text', text: '391' }
          ]
        }
      ]
    })
  })

  it('preserves signature and closed on ThinkChunks', () => {
    expect(
      parseOpenAiCompatDeltaContent([
        {
          type: 'thinking',
          thinking: [{ type: 'text', text: 'step A' }],
          signature: 'sig-a',
          closed: true
        },
        {
          type: 'thinking',
          thinking: [{ type: 'text', text: 'step B' }],
          signature: 'sig-b',
          closed: true
        },
        { type: 'text', text: 'done' }
      ])
    ).toEqual({
      text: 'done',
      reasoning: 'step Astep B',
      thinkChunks: [
        {
          text: 'step A',
          signature: 'sig-a',
          closed: true,
          thinking: [{ type: 'text', text: 'step A' }]
        },
        {
          text: 'step B',
          signature: 'sig-b',
          closed: true,
          thinking: [{ type: 'text', text: 'step B' }]
        }
      ]
    })
  })

  it('preserves ToolReference and Reference inner parts', () => {
    expect(
      parseOpenAiCompatDeltaContent([
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
            { type: 'reference', reference_ids: [1, 'a'] }
          ]
        }
      ])
    ).toEqual({
      text: null,
      reasoning: 'See ',
      thinkChunks: [
        {
          text: 'See ',
          thinking: [
            { type: 'text', text: 'See ' },
            {
              type: 'tool_reference',
              tool: 'web_search',
              title: 'Docs',
              url: 'https://example.com'
            },
            { type: 'reference', reference_ids: [1, 'a'] }
          ]
        }
      ]
    })
  })

  it('handles thinking-only and string thinking field', () => {
    expect(
      parseOpenAiCompatDeltaContent([{ type: 'thinking', thinking: 'step one' }])
    ).toEqual({ text: null, reasoning: 'step one', thinkChunks: [{ text: 'step one' }] })
  })

  it('omits include_usage when omitIncludeUsage override is set', () => {
    const body = buildOpenAiCompatBody(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal
      },
      { defaultBaseUrl: 'https://api.openai.com/v1' },
      'openai',
      { omitIncludeUsage: true }
    )
    expect(body.stream_options).toBeUndefined()
  })
})

describe('toOpenAiCompatThinkChunkContent', () => {
  it('builds closed ThinkChunk plus TextChunk for multi-turn replay', () => {
    expect(toOpenAiCompatThinkChunkContent('answer', 'reason')).toEqual([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'reason' }],
        closed: true
      },
      { type: 'text', text: 'answer' }
    ])
    expect(toOpenAiCompatThinkChunkContent(null, 'reason only')).toEqual([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'reason only' }],
        closed: true
      }
    ])
  })

  it('replays stored multi-chunk layout with signatures', () => {
    expect(
      toOpenAiCompatThinkChunkContent('final', 'step Astep B', [
        { text: 'step A', signature: 'sig-a', closed: true },
        { text: 'step B', signature: 'sig-b', closed: true }
      ])
    ).toEqual([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'step A' }],
        closed: true,
        signature: 'sig-a'
      },
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'step B' }],
        closed: true,
        signature: 'sig-b'
      },
      { type: 'text', text: 'final' }
    ])
  })

  it('replays full inner thinking parts without flattening', () => {
    expect(
      toOpenAiCompatThinkChunkContent('answer', 'See docs', [
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
            { type: 'text', text: 'docs' },
            { type: 'reference', reference_ids: [3] }
          ]
        }
      ])
    ).toEqual([
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
          { type: 'text', text: 'docs' },
          { type: 'reference', reference_ids: [3] }
        ],
        closed: true
      },
      { type: 'text', text: 'answer' }
    ])
  })
})

describe('absorbOpenAiCompatThinkChunks', () => {
  it('appends into an open chunk and starts a new one after closed', () => {
    const mid = absorbOpenAiCompatThinkChunks([], [{ text: 'a' }])
    expect(mid).toEqual([{ text: 'a' }])
    const continued = absorbOpenAiCompatThinkChunks(mid, [
      { text: 'b', signature: 's1', closed: true }
    ])
    expect(continued).toEqual([{ text: 'ab', signature: 's1', closed: true }])
    const next = absorbOpenAiCompatThinkChunks(continued, [
      { text: 'c', signature: 's2', closed: true }
    ])
    expect(next).toEqual([
      { text: 'ab', signature: 's1', closed: true },
      { text: 'c', signature: 's2', closed: true }
    ])
  })

  it('keeps two unclosed ThinkChunks in one delta as separate chunks', () => {
    expect(
      absorbOpenAiCompatThinkChunks(
        [],
        [
          { text: 'first', thinking: [{ type: 'text', text: 'first' }] },
          { text: 'second', thinking: [{ type: 'text', text: 'second' }] }
        ]
      )
    ).toEqual([
      { text: 'first', thinking: [{ type: 'text', text: 'first' }] },
      { text: 'second', thinking: [{ type: 'text', text: 'second' }] }
    ])
  })

  it('merges structured inners across frames into the open chunk', () => {
    const mid = absorbOpenAiCompatThinkChunks(
      [],
      [{ text: 'Hel', thinking: [{ type: 'text', text: 'Hel' }] }]
    )
    expect(
      absorbOpenAiCompatThinkChunks(mid, [
        { text: 'lo', thinking: [{ type: 'text', text: 'lo' }], closed: true }
      ])
    ).toEqual([
      {
        text: 'Hello',
        closed: true,
        thinking: [
          { type: 'text', text: 'Hel' },
          { type: 'text', text: 'lo' }
        ]
      }
    ])
  })
})
