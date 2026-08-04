import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicProvider } from '@main/agent/providers/anthropic'
import { mistralProvider, openrouterProvider } from '@main/agent/providers/openai'
import { streamGeminiInteractions } from '@main/agent/providers/geminiInteractions'
import { streamOpenAiResponses } from '@main/agent/providers/openaiResponses'
import { iterateSseData, iterateSseJson, STREAM_IDLE_TIMEOUT_MS } from '@main/agent/providers/sse'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'

function sseBody(frames: string[]): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

function chunkedResponse(chunks: string[]): { res: Response; cancelled: () => boolean } {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
    cancel() {
      cancelled = true
    }
  })
  return { res: new Response(stream), cancelled: () => cancelled }
}

function neverEndingResponse(chunks: string[]): { res: Response; cancelled: () => boolean } {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
    },
    cancel() {
      cancelled = true
    }
  })
  return { res: new Response(stream), cancelled: () => cancelled }
}

const baseReq = (partial: Partial<ProviderChatRequest> = {}): ProviderChatRequest => ({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
  apiKey: 'test-key',
  ...partial
})

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

describe('SSE frame parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reassembles frames split across read boundaries', async () => {
    const { res } = chunkedResponse(['data: {"a"', ':1}\n', '\ndata: {"b":2}\n\n'])
    const out: string[] = []
    for await (const data of iterateSseData(res, new AbortController().signal)) out.push(data)
    expect(out).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('joins multi-line data fields and skips comments and CRLF', async () => {
    const { res } = chunkedResponse([
      ': keepalive\r\n',
      'event: message\r\n',
      'data: line one\r\n',
      'data: line two\r\n',
      '\r\n',
      'data: [DONE]\r\n\r\n'
    ])
    const out: string[] = []
    for await (const data of iterateSseData(res, new AbortController().signal)) out.push(data)
    expect(out).toEqual(['line one\nline two'])
  })

  it('counts malformed JSON frames instead of failing the stream', async () => {
    const { res } = chunkedResponse(['data: not json\n\n', 'data: {"ok":true}\n\n'])
    const drops = { dropped: 0 }
    const out: Record<string, unknown>[] = []
    for await (const ev of iterateSseJson(res, new AbortController().signal, drops)) out.push(ev)
    expect(out).toEqual([{ ok: true }])
    expect(drops.dropped).toBe(1)
  })

  it('cancels the response body when the consumer stops reading early', async () => {
    const { res, cancelled } = neverEndingResponse(['data: {"a":1}\n\n', 'data: {"b":2}\n\n'])
    for await (const _data of iterateSseData(res, new AbortController().signal)) {
      break
    }
    expect(cancelled()).toBe(true)
  })

  it('throws StreamIdleTimeoutError when no bytes arrive within the idle window', async () => {
    vi.useFakeTimers()
    const { res, cancelled } = neverEndingResponse([])
    const pending = iterateSseData(res, new AbortController().signal, {
      idleTimeoutMs: 1_000
    }).next()
    const expectation = expect(pending).rejects.toMatchObject({
      name: 'StreamIdleTimeoutError',
      idleMs: 1_000
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await expectation
    expect(cancelled()).toBe(true)
  })

  it('resets the idle timer when SSE keep-alive comments arrive', async () => {
    vi.useFakeTimers()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    const res = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
        }
      })
    )
    const pending = iterateSseData(res, new AbortController().signal, {
      idleTimeoutMs: 5_000
    }).next()

    await vi.advanceTimersByTimeAsync(4_000)
    controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n'))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(4_000)
    controller.enqueue(encoder.encode('data: hello\n\n'))
    controller.close()

    await expect(pending).resolves.toEqual({ done: false, value: 'hello' })
  })

  it('exposes the default idle threshold at 10 minutes', () => {
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(10 * 60 * 1000)
  })
})

describe('anthropic stream usage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports cache reads and cache writes in their own usage fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'event: message_start\n',
          'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1200,"cache_read_input_tokens":900,"cache_creation_input_tokens":10,"output_tokens":1}}}\n\n',
          'event: content_block_start\n',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
          'event: message_delta\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
          'event: message_stop\n',
          'data: {"type":"message_stop"}\n\n'
        ])
      )
    )

    const chunks = await collect(anthropicProvider.streamChat(baseReq()))
    const done = chunks.find((c) => c.type === 'done')

    expect(done?.stopReason).toBe('stop')
    // Anthropic reports cache reads/writes outside `input_tokens`; they ride their
    // own usage fields instead of being summed into the meter input.
    expect(done?.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 42,
      cachedInputTokens: 900,
      cacheCreationInputTokens: 10,
      reasoningTokens: undefined,
      totalTokens: 1242
    })
  })

  it('keeps message_start input tokens when message_delta only reports output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":0}}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":7}}\n\n'
        ])
      )
    )

    const chunks = await collect(anthropicProvider.streamChat(baseReq()))
    const done = chunks.find((c) => c.type === 'done')

    expect(done?.usage?.inputTokens).toBe(50)
    expect(done?.usage?.outputTokens).toBe(7)
    expect(done?.stopReason).toBe('length')
  })
})

describe('openai responses stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('surfaces the provider error message when the response fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
          'data: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"server_error","message":"The model produced invalid content."}}}\n\n'
        ])
      )
    )

    const chunks = await collect(streamOpenAiResponses(baseReq({ model: 'gpt-5' })))
    const error = chunks.find((c) => c.type === 'error')

    expect(error?.error).toContain('The model produced invalid content.')
  })

  it('streams tool call argument deltas keyed by item_id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read"}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"path\\":"}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"\\"a.ts\\"}"}\n\n',
          'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":5}}}\n\n'
        ])
      )
    )

    const chunks = await collect(streamOpenAiResponses(baseReq({ model: 'gpt-5' })))
    const deltas = chunks.filter((c) => c.type === 'tool_call_delta')

    expect(deltas[0]?.toolCallDelta).toMatchObject({
      id: 'call_1',
      name: 'read',
      arguments: ''
    })
    expect(deltas.map((d) => d.toolCallDelta?.arguments).join('')).toBe('{"path":"a.ts"}')
    expect(deltas.every((d) => d.toolCallDelta?.id === 'call_1')).toBe(true)
    expect(chunks.filter((c) => c.type === 'tool_call')).toHaveLength(1)
  })

  it('emits thinking_done before answer text when reasoning precedes content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"choices":[{"delta":{"reasoning_content":"Let me greet."}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
        ])
      )
    )

    const chunks = await collect(
      openrouterProvider.streamChat(baseReq({ model: 'deepseek/deepseek-v3' }))
    )
    const types = chunks.map((c) => c.type)

    expect(types.indexOf('thinking_done')).toBeLessThan(types.indexOf('text'))
    expect(chunks.filter((c) => c.type === 'thinking_done')).toHaveLength(1)
  })
})

describe('DeepInfra DeepSeek dual-field SSE', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const flash0731Req = (partial: Partial<ProviderChatRequest> = {}): ProviderChatRequest =>
    baseReq({
      model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      baseUrl: 'https://api.deepinfra.com/v1/openai',
      thinking: { enabled: true, effort: 'high', display: 'summarized' },
      ...partial
    })

  it('yields thinking_delta from delta.reasoning_content only (Flash-0731)', async () => {
    const { customProvider } = await import('@main/agent/providers/openai')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"choices":[{"delta":{"reasoning_content":"Scout the file tree."}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning_content":" Then write."}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
        ])
      )
    )

    const chunks = await collect(customProvider.streamChat(flash0731Req()))
    const thinking = chunks
      .filter((c) => c.type === 'thinking_delta')
      .map((c) => c.text)
      .join('')

    expect(thinking).toBe('Scout the file tree. Then write.')
    expect(chunks.some((c) => c.type === 'text')).toBe(false)
    expect(chunks.find((c) => c.type === 'thinking_done')?.text).toBe(
      'Scout the file tree. Then write.'
    )
    expect(chunks.find((c) => c.type === 'done')?.reasoningState).toMatchObject({
      kind: 'openai_compat',
      reasoningContent: 'Scout the file tree. Then write.',
      reasoningFormat: 'reasoning_content'
    })
  })

  it('parses reasoning_content and content in the same SSE chunk independently', async () => {
    const { customProvider } = await import('@main/agent/providers/openai')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"choices":[{"delta":{"reasoning_content":"Plan.","content":"Answer."}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
        ])
      )
    )

    const chunks = await collect(customProvider.streamChat(flash0731Req()))
    expect(
      chunks.filter((c) => c.type === 'thinking_delta').map((c) => c.text).join('')
    ).toBe('Plan.')
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')).toBe('Answer.')
    const types = chunks.map((c) => c.type)
    expect(types.indexOf('thinking_done')).toBeLessThan(types.indexOf('text'))
  })

  it('accepts string delta.reasoning as a reasoning_content alias', async () => {
    const { customProvider } = await import('@main/agent/providers/openai')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"choices":[{"delta":{"reasoning":"Via alias."}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Done."}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
        ])
      )
    )

    const chunks = await collect(customProvider.streamChat(flash0731Req()))
    expect(
      chunks.filter((c) => c.type === 'thinking_delta').map((c) => c.text).join('')
    ).toBe('Via alias.')
    expect(chunks.find((c) => c.type === 'done')?.reasoningState).toMatchObject({
      reasoningFormat: 'reasoning_content',
      reasoningContent: 'Via alias.'
    })
  })
})

describe('mistral ThinkChunk stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('streams thinking_delta from ThinkChunk content then answer text', async () => {
    const thinkFrame = JSON.stringify({
      choices: [
        {
          delta: {
            content: [
              {
                type: 'thinking',
                thinking: [{ type: 'text', text: 'Multiply carefully.' }]
              }
            ]
          }
        }
      ]
    })
    const transitionFrame = JSON.stringify({
      choices: [
        {
          delta: {
            content: [
              { type: 'thinking', thinking: [{ type: 'text', text: ' Done.' }] },
              { type: 'text', text: '391' }
            ]
          }
        }
      ]
    })
    const answerFrame = JSON.stringify({
      choices: [{ delta: { content: ' is the answer.' } }]
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          `data: ${thinkFrame}\n\n`,
          `data: ${transitionFrame}\n\n`,
          `data: ${answerFrame}\n\n`,
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
        ])
      )
    )

    const chunks = await collect(
      mistralProvider.streamChat(baseReq({ model: 'mistral-medium-3-5' }))
    )
    const thinking = chunks
      .filter((c) => c.type === 'thinking_delta')
      .map((c) => c.text)
      .join('')
    const text = chunks
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
    const types = chunks.map((c) => c.type)

    expect(thinking).toBe('Multiply carefully. Done.')
    expect(text).toBe('391 is the answer.')
    expect(types.indexOf('thinking_done')).toBeLessThan(types.indexOf('text'))
    const done = chunks.find((c) => c.type === 'done')
    expect(done?.reasoningState).toEqual({
      kind: 'openai_compat',
      reasoningContent: 'Multiply carefully. Done.',
      reasoningDetails: undefined,
      reasoningFormat: 'think_chunks',
      thinkChunks: [
        {
          text: 'Multiply carefully. Done.',
          closed: true,
          thinking: [
            { type: 'text', text: 'Multiply carefully.' },
            { type: 'text', text: ' Done.' }
          ]
        }
      ]
    })
  })

  it('stores multi-chunk ThinkChunks with signatures for replay', async () => {
    const thinkFrame = JSON.stringify({
      choices: [
        {
          delta: {
            content: [
              {
                type: 'thinking',
                thinking: [{ type: 'text', text: 'First.' }],
                signature: 'sig-1',
                closed: true
              },
              {
                type: 'thinking',
                thinking: [{ type: 'text', text: 'Second.' }],
                signature: 'sig-2',
                closed: true
              }
            ]
          }
        }
      ]
    })
    const answerFrame = JSON.stringify({
      choices: [{ delta: { content: 'ok' } }]
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          `data: ${thinkFrame}\n\n`,
          `data: ${answerFrame}\n\n`,
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
        ])
      )
    )

    const chunks = await collect(
      mistralProvider.streamChat(baseReq({ model: 'mistral-medium-3-5' }))
    )
    const done = chunks.find((c) => c.type === 'done')
    expect(done?.reasoningState).toEqual({
      kind: 'openai_compat',
      reasoningContent: 'First.Second.',
      reasoningDetails: undefined,
      reasoningFormat: 'think_chunks',
      thinkChunks: [
        {
          text: 'First.',
          signature: 'sig-1',
          closed: true,
          thinking: [{ type: 'text', text: 'First.' }]
        },
        {
          text: 'Second.',
          signature: 'sig-2',
          closed: true,
          thinking: [{ type: 'text', text: 'Second.' }]
        }
      ]
    })
  })

  it('keeps two unclosed ThinkChunks in one delta as separate stored chunks', async () => {
    const thinkFrame = JSON.stringify({
      choices: [
        {
          delta: {
            content: [
              {
                type: 'thinking',
                thinking: [{ type: 'text', text: 'Alpha' }]
              },
              {
                type: 'thinking',
                thinking: [{ type: 'text', text: 'Beta' }]
              }
            ]
          }
        }
      ]
    })
    const answerFrame = JSON.stringify({
      choices: [{ delta: { content: 'ok' } }]
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          `data: ${thinkFrame}\n\n`,
          `data: ${answerFrame}\n\n`,
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
        ])
      )
    )

    const chunks = await collect(
      mistralProvider.streamChat(baseReq({ model: 'mistral-medium-3-5' }))
    )
    const done = chunks.find((c) => c.type === 'done')
    expect(done?.reasoningState).toEqual({
      kind: 'openai_compat',
      reasoningContent: 'AlphaBeta',
      reasoningDetails: undefined,
      reasoningFormat: 'think_chunks',
      thinkChunks: [
        {
          text: 'Alpha',
          closed: true,
          thinking: [{ type: 'text', text: 'Alpha' }]
        },
        {
          text: 'Beta',
          closed: true,
          thinking: [{ type: 'text', text: 'Beta' }]
        }
      ]
    })
  })

  it('retries without stream_options.include_usage when host rejects it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'Extra inputs are not permitted: stream_options' }
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        sseBody([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
        ])
      )
    vi.stubGlobal('fetch', fetchMock)

    const { customProvider } = await import('@main/agent/providers/openai')
    const chunks = await collect(
      customProvider.streamChat(
        baseReq({ model: 'local-model', baseUrl: 'http://127.0.0.1:8080/v1' })
      )
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      stream_options?: unknown
    }
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as {
      stream_options?: unknown
    }
    expect(firstBody.stream_options).toEqual({ include_usage: true })
    expect(secondBody.stream_options).toBeUndefined()
    expect(chunks.some((c) => c.type === 'text' && c.text === 'ok')).toBe(true)
  })
})

describe('anthropic thinking block boundaries', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('emits thinking_done when a thinking block closes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan first."}}\n\n',
          'data: {"type":"content_block_stop","index":0}\n\n',
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
        ])
      )
    )

    const chunks = await collect(anthropicProvider.streamChat(baseReq()))
    const types = chunks.map((c) => c.type)

    expect(types.indexOf('thinking_done')).toBeLessThan(types.indexOf('text'))
    expect(chunks.find((c) => c.type === 'thinking_done')?.text).toBe('Plan first.')
  })

  it('emits tool_call_delta when a tool_use block starts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
          'data: {"type":"content_block_stop","index":0}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n'
        ])
      )
    )

    const chunks = await collect(anthropicProvider.streamChat(baseReq()))
    const deltas = chunks.filter((c) => c.type === 'tool_call_delta')

    expect(deltas[0]?.toolCallDelta).toMatchObject({
      id: 'toolu_1',
      name: 'read',
      arguments: ''
    })
    expect(deltas[1]?.toolCallDelta?.arguments).toBe('{"path":"a.ts"}')
  })
})

describe('openai compat tool-before-text ordering', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('yields tool_call_delta before text when both arrive in the same SSE frame', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"choices":[{"delta":{"content":"Looking up.","tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n'
        ])
      )
    )

    const chunks = await collect(
      openrouterProvider.streamChat(baseReq({ model: 'deepseek/deepseek-v3' }))
    )
    const types = chunks.map((c) => c.type)
    const toolIdx = types.indexOf('tool_call_delta')
    const textIdx = types.indexOf('text')

    expect(toolIdx).toBeGreaterThanOrEqual(0)
    expect(textIdx).toBeGreaterThan(toolIdx)
  })
})

describe('gemini mid-stream tool_call', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('yields tool_call when a functionCall part appears mid-stream', async () => {
    const { geminiProvider } = await import('@main/agent/providers/gemini')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"candidates":[{"content":{"parts":[{"text":"Checking."}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"a.ts"},"id":"g1"}}]}}]}\n\n',
          'data: {"candidates":[{"finishReason":"STOP"}]}\n\n'
        ])
      )
    )

    const chunks = await collect(
      geminiProvider.streamChat(
        baseReq({ model: 'gemini-2.0-flash', apiKey: 'test-key', tools: [] })
      )
    )
    const midStreamCalls = chunks.filter((c) => c.type === 'tool_call')
    const textIdx = chunks.findIndex((c) => c.type === 'text')
    const firstCallIdx = chunks.findIndex((c) => c.type === 'tool_call')

    expect(midStreamCalls).toHaveLength(1)
    expect(firstCallIdx).toBeGreaterThan(textIdx)
    expect(midStreamCalls[0]?.toolCall).toMatchObject({
      id: 'g1',
      name: 'read',
      arguments: '{"path":"a.ts"}'
    })
  })

  it('uses generateContent when thinking is disabled even if thinkingApi is interactions', async () => {
    const { geminiProvider } = await import('@main/agent/providers/gemini')
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      expect(url).toMatch(/generateContent|:streamGenerateContent/)
      expect(url).not.toMatch(/interactions/)
      return sseBody([
        'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP"}]}\n\n'
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    await collect(
      geminiProvider.streamChat(
        baseReq({
          model: 'gemini-2.5-flash',
          apiKey: 'test-key',
          tools: [],
          thinking: { enabled: false },
          modelInfo: {
            id: 'gemini-2.5-flash',
            label: 'Gemini 2.5 Flash',
            contextWindow: 1_000_000,
            thinkingApi: 'interactions'
          } as never
        })
      )
    )
    expect(fetchMock).toHaveBeenCalled()
  })
})

describe('gemini interactions stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('streams text deltas and reports the interaction id in reasoning state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"event_type":"step.delta","interaction":{"id":"int_1"},"delta":{"type":"text","text":"Hello"}}\n\n',
          'data: {"event_type":"step.delta","delta":{"type":"text","text":" world"}}\n\n',
          'data: {"event_type":"interaction.completed","interaction":{"id":"int_1","finish_reason":"stop"}}\n\n'
        ])
      )
    )

    const chunks = await collect(streamGeminiInteractions(baseReq({ model: 'gemini-3-pro' })))
    const done = chunks.find((c) => c.type === 'done')

    expect(chunks.filter((c) => c.type === 'text').map((c) => c.text)).toEqual([
      'Hello',
      ' world'
    ])
    expect(done?.stopReason).toBe('stop')
    expect(done?.reasoningState).toEqual({
      kind: 'gemini_interactions',
      interactionId: 'int_1'
    })
  })

  it('yields tool_call when a function_call delta arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"event_type":"step.delta","interaction":{"id":"int_1"},"delta":{"type":"function_call","function_call":{"id":"fc_1","name":"read","args":{"path":"a.ts"}}}}\n\n',
          'data: {"event_type":"interaction.completed","interaction":{"id":"int_1","finish_reason":"function_call"}}\n\n'
        ])
      )
    )

    const chunks = await collect(streamGeminiInteractions(baseReq({ model: 'gemini-3-pro' })))
    const calls = chunks.filter((c) => c.type === 'tool_call')
    const done = chunks.find((c) => c.type === 'done')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.toolCall).toEqual({
      id: 'fc_1',
      name: 'read',
      arguments: '{"path":"a.ts"}'
    })
    expect(done?.stopReason).toBe('tool_calls')
  })

  it('maps interaction usage onto the done chunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"event_type":"interaction.completed","interaction":{"id":"int_1","finish_reason":"stop","usage":{"total_input_tokens":100,"total_output_tokens":25,"total_tokens":125,"total_cached_tokens":40,"total_thought_tokens":12}}}\n\n'
        ])
      )
    )

    const chunks = await collect(streamGeminiInteractions(baseReq({ model: 'gemini-3-pro' })))
    const done = chunks.find((c) => c.type === 'done')

    expect(done?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      cachedInputTokens: 40,
      reasoningTokens: 12
    })
  })

  it('sends previous_interaction_id with only trailing tool results when continuing', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseBody([
        'data: {"event_type":"step.delta","interaction":{"id":"int_next"},"delta":{"type":"text","text":"Done."}}\n\n',
        'data: {"event_type":"interaction.completed","interaction":{"id":"int_next","finish_reason":"stop"}}\n\n'
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const chunks = await collect(
      streamGeminiInteractions(
        baseReq({
          model: 'gemini-3-pro',
          system: 'system',
          messages: [
            { role: 'user', content: 'hi' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
            },
            { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'ok' }
          ],
          reasoningState: { kind: 'gemini_interactions', interactionId: 'int_prev' }
        })
      )
    )

    expect(capturedBody?.previous_interaction_id).toBe('int_prev')
    expect(capturedBody?.input).toEqual([
      {
        type: 'function_response',
        function_response: { id: 'c1', name: 'read', response: { output: 'ok' } }
      }
    ])
    const done = chunks.find((c) => c.type === 'done')
    expect(done?.reasoningState).toEqual({
      kind: 'gemini_interactions',
      interactionId: 'int_next'
    })
  })
})

describe('openai responses thinking boundaries', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('emits thinking_done before output text when reasoning streams first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseBody([
          'data: {"type":"response.reasoning_summary_text.delta","delta":"Reasoning."}\n\n',
          'data: {"type":"response.output_text.delta","delta":"Answer."}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'
        ])
      )
    )

    const chunks = await collect(streamOpenAiResponses(baseReq({ model: 'gpt-5' })))
    const types = chunks.map((c) => c.type)

    expect(types.indexOf('thinking_done')).toBeLessThan(types.indexOf('text'))
    expect(chunks.filter((c) => c.type === 'thinking_done')).toHaveLength(1)
  })
})
