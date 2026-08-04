import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'

const userData = join(tmpdir(), `vyotiq-stopreason-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

vi.mock('@main/agent/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/mcp')>()
  return {
    ...actual,
    syncMcpServers: vi.fn(async () => {}),
    listMcpToolDefinitions: () => []
  }
})

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    theme: 'system',
    telemetryEnabled: false,
    // Isolate stop-reason behavior from soft finish gates (default contract
    // may include a typecheck criterion; require mode would nudge forever here).
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))
vi.mock('@main/agent/harness', () => ({ loadHarness: () => 'harness' }))

const { streamChat, executeTool, assembleContext } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn(),
  assembleContext: vi.fn(async (input: { messages: unknown[] }) => ({
    messages: input.messages,
    system: 'system',
    estimatedTokens: 100,
    layers: { system: 10, history: 50, tools: 20, buffer: 20 },
    contextShrunk: false,
    overflow: false,
    anthropicNative: undefined,
    compaction: null
  }))
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: (...args: unknown[]) => assembleContext(...args),
    ensureMemoryLayout: () => undefined
  }
})

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({ id: 'ollama', listModels: async () => [], streamChat }),
  listProviderModels: async () => ({
    models: [
      {
        id: 'qwen2.5',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      }
    ]
  })
}))

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

const { saveCompactionFails } = vi.hoisted(() => ({
  saveCompactionFails: { value: false }
}))

vi.mock('@main/agent/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/state')>()
  return {
    ...actual,
    saveCompaction: (...args: Parameters<typeof actual.saveCompaction>) =>
      saveCompactionFails.value ? false : actual.saveCompaction(...args)
  }
})

import { runAgent } from '@main/agent/loop'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'

type CapturedEvent = {
  type: string
  status?: string
  reason?: string
  content?: string
  code?: string
  message?: string
  toolCallId?: string
  name?: string
  argumentsDelta?: string
}

async function collect(runId: string, workspace: string): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = []
  for await (const ev of runAgent({
    runId,
    messages: [{ role: 'user', content: 'do the thing' }],
    workspacePath: workspace
  })) {
    events.push(ev as CapturedEvent)
  }
  return events
}

describe('runAgent stop-reason classification', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-stopreason-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockReset()
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      contextShrunk: false,
      overflow: false,
      anthropicNative: undefined,
      compaction: null
    }))
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('auto-continues after a truncated step then finishes', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'text', text: 'half an ans' }
        yield { type: 'done', stopReason: 'length' }
      } else {
        yield { type: 'text', text: 'wer completed' }
        yield { type: 'done', stopReason: 'stop' }
      }
    })

    const events = await collect('stop-truncated-continue', workspace)
    expect(call).toBe(2)
    expect(events.filter((e) => e.type === 'incomplete')).toHaveLength(1)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('reports truncation when the auto-continue budget is exhausted', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'still going' }
      yield { type: 'done', stopReason: 'length' }
    })

    const events = await collect('stop-truncated', workspace)
    const incomplete = events.filter((e) => e.type === 'incomplete')

    expect(incomplete.length).toBeGreaterThanOrEqual(1)
    expect(incomplete[incomplete.length - 1]?.reason).toBe('truncated')
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('reports an empty response when the model returns nothing at all', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('stop-empty', workspace)

    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('empty_response')
  })

  it('reports a content filter stop', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial' }
      yield { type: 'done', stopReason: 'content_filter' }
    })

    const events = await collect('stop-filtered', workspace)

    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('filtered')
  })

  it('stays silent when the model finishes cleanly', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'all done' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('stop-clean', workspace)

    expect(events.some((e) => e.type === 'incomplete')).toBe(false)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('live-forwards tool_call chunks as tool_call_delta before assistant_message', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'text', text: 'checking' }
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'ok' })

    const events = await collect('live-forward-tool', workspace)
    const deltaIdx = events.findIndex((e) => e.type === 'tool_call_delta')
    const msgIdx = events.findIndex((e) => e.type === 'assistant_message')

    expect(deltaIdx).toBeGreaterThanOrEqual(0)
    expect(msgIdx).toBeGreaterThan(deltaIdx)
    expect(events[deltaIdx]).toMatchObject({
      type: 'tool_call_delta',
      toolCallId: 'c1',
      name: 'read',
      argumentsDelta: '{"path":"a.ts"}'
    })

    const eventsPath = join(resolveRunDir(workspace, 'live-forward-tool'), 'events.jsonl')
    const persisted = readFileSync(eventsPath, 'utf8')
    expect(persisted).toContain('"type":"tool_call_delta"')
    expect(persisted).toContain('"toolCallId":"c1"')
  })

  it('does not concatenate full tool_call args on a second live-forward of the same id', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'ok' })

    const events = await collect('live-forward-dedupe', workspace)
    const deltas = events.filter((e) => e.type === 'tool_call_delta') as Array<{
      argumentsDelta?: string
    }>

    expect(deltas[0]?.argumentsDelta).toBe('{"path":"a.ts"}')
    expect(deltas[1]?.argumentsDelta).toBe('')
  })

  it('reports truncation when stopReason is tool_calls but no tools were parsed', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'about to call' }
      yield { type: 'done', stopReason: 'tool_calls' }
    })

    const events = await collect('stop-tool-parse-fail', workspace)

    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('truncated')
  })

  it('reports truncation when a provider error arrives after partial text', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial answer' }
      yield { type: 'done', stopReason: 'error' }
    })

    const events = await collect('stop-error-partial', workspace)

    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('truncated')
  })

  it('treats a missing stop reason with real text as a clean finish', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'answer' }
      yield { type: 'done' }
    })

    const events = await collect('stop-unset', workspace)

    expect(events.some((e) => e.type === 'incomplete')).toBe(false)
  })
})

describe('runAgent context overflow', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-overflow-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    saveCompactionFails.value = false
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockReset()
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      contextShrunk: false,
      overflow: false,
      anthropicNative: undefined,
      compaction: null
    }))
  })

  afterEach(() => {
    saveCompactionFails.value = false
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('stops before streaming when assembleContext reports overflow', async () => {
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 200_000,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      contextShrunk: true,
      overflow: true,
      anthropicNative: undefined,
      compaction: null
    }))

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'should not stream' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('overflow-stop', workspace)

    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('context_overflow')
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
    expect(events.some((e) => e.type === 'text_delta')).toBe(false)
    expect(streamChat).not.toHaveBeenCalled()
  })

  it('ends the step instead of streaming when the trim watermark cannot persist', async () => {
    saveCompactionFails.value = true
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages.slice(1),
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      contextShrunk: true,
      overflow: false,
      anthropicNative: undefined,
      compaction: null
    }))
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'should not stream' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('trim-watermark-persist-fail', workspace)

    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
    expect(events.some((e) => e.type === 'text_delta')).toBe(false)
    expect(streamChat).not.toHaveBeenCalled()
  })

  it('does not adopt an overflow retry whose trim watermark cannot persist', async () => {
    saveCompactionFails.value = true
    let assembleCall = 0
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => {
      assembleCall += 1
      if (assembleCall === 1) {
        return {
          messages: input.messages,
          system: 'system',
          estimatedTokens: 200_000,
          layers: { system: 10, history: 50, tools: 20, buffer: 20 },
          contextShrunk: false,
          overflow: true,
          anthropicNative: undefined,
          compaction: null
        }
      }
      return {
        messages: input.messages.slice(1),
        system: 'system',
        estimatedTokens: 100,
        layers: { system: 10, history: 50, tools: 20, buffer: 20 },
        contextShrunk: true,
        overflow: false,
        anthropicNative: undefined,
        compaction: null
      }
    })
    // Snapshot at call time: the loop reuses the live messages array, so reading
    // mock.calls after the run would include the assistant reply appended later.
    let firstStreamMessages: Array<{ role: string; content: string }> | undefined
    streamChat.mockImplementation(async function* (request: {
      messages: Array<{ role: string; content: string }>
    }): AsyncGenerator<StreamChunk> {
      firstStreamMessages ??= request.messages.map((m) => ({ ...m }))
      yield { type: 'text', text: 'streamed with original context' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('overflow-retry-watermark-fail', workspace)

    expect(streamChat).toHaveBeenCalledTimes(1)
    expect(firstStreamMessages).toMatchObject([{ role: 'user', content: 'do the thing' }])
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })
})

describe('runAgent partial persistence', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-partial-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockReset()
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      contextShrunk: false,
      overflow: false,
      anthropicNative: undefined,
      compaction: null
    }))
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('keeps text that streamed before a non-retriable provider error', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'streamed before the failure' }
      yield { type: 'error', error: 'HTTP 400: bad request' }
    })

    const runId = 'partial-on-error'
    const events = await collect(runId, workspace)

    expect(events.some((e) => e.type === 'error' && e.code === 'PROVIDER_STREAM')).toBe(true)

    const messages = readFileSync(join(resolveRunDir(workspace, runId), 'messages.jsonl'), 'utf8')
    expect(messages).toContain('streamed before the failure')
  })

  it('emits PROVIDER_STREAM when a retriable thrown stream error exhausts attempts', async () => {
    const { RetriableStreamError } = await import('@main/agent/providers/fetchWithRetry')
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial before disconnect' }
      throw new RetriableStreamError('stream ended')
    })

    const events = await collect('thrown-stream-exhausted', workspace)

    expect(events.some((e) => e.type === 'error' && e.code === 'PROVIDER_STREAM')).toBe(true)
    expect(events.some((e) => e.type === 'error' && e.code === 'AGENT_LOOP')).toBe(false)
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
  })

  it('emits stream_reset so the UI drops output from a retried attempt', async () => {
    let attempt = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      attempt += 1
      if (attempt === 1) {
        yield { type: 'text', text: 'doomed first attempt' }
        yield { type: 'error', error: 'socket hang up' }
        return
      }
      yield { type: 'text', text: 'good second attempt' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('partial-retry', workspace)

    expect(events.some((e) => e.type === 'stream_reset')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('emits stream_reset when the failed attempt only streamed tool deltas', async () => {
    let attempt = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      attempt += 1
      if (attempt === 1) {
        yield {
          type: 'tool_call_delta',
          toolCallDelta: {
            index: 0,
            id: 'call_1',
            name: 'read',
            arguments: '{"path":'
          }
        }
        yield { type: 'error', error: 'socket hang up' }
        return
      }
      yield { type: 'text', text: 'recovered' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'tool-delta-retry'
    const events = await collect(runId, workspace)

    expect(events.some((e) => e.type === 'stream_reset')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)

    const eventsPath = join(resolveRunDir(workspace, runId), 'events.jsonl')
    const persisted = readFileSync(eventsPath, 'utf8')
    expect(persisted).toContain('"type":"stream_reset"')
    // Stale chrome from attempt 1 is followed by a persisted reset before recovery text.
    const resetIdx = persisted.indexOf('"type":"stream_reset"')
    const deltaIdx = persisted.indexOf('"toolCallId":"call_1"')
    expect(deltaIdx).toBeGreaterThanOrEqual(0)
    expect(resetIdx).toBeGreaterThan(deltaIdx)
  })
})
