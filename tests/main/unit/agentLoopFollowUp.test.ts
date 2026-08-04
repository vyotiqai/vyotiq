import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-followup-${process.pid}-${Date.now()}`)

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
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

vi.mock('@main/agent/harness', () => ({
  loadHarness: () => 'harness'
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      contextShrunk: false,
      anthropicNative: undefined,
      compaction: null
    }),
    ensureMemoryLayout: () => undefined
  }
})

const { streamChat } = vi.hoisted(() => ({
  streamChat: vi.fn()
}))

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat
  }),
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
  executeTool: vi.fn()
}))

import { runAgent } from '@main/agent/loop'
import { enqueueFollowUp, resetActiveRunsForTests } from '@main/agent/runRegistry'
import { loadMessages } from '@main/agent/state'
import { executeTool } from '@main/agent/tools'

describe('runAgent mid-run follow-ups', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-followup-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('soft-interrupts the stream, applies follow-ups, then continues to done', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (
      req: ProviderChatRequest
    ): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'text', text: 'working…' }
        while (!req.signal.aborted) {
          await new Promise((r) => setTimeout(r, 5))
        }
        return
      }
      yield { type: 'text', text: 'steered reply' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'follow-up-loop'
    const events: Array<{ type: string; status?: string; content?: string; ids?: string[] }> = []

    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'start' }],
      workspacePath: workspace
    })) {
      events.push(ev)
      if (ev.type === 'text_delta' && ev.text === 'working…') {
        enqueueFollowUp(runId, { role: 'user', content: 'change course' })
      }
    }

    expect(events.some((e) => e.type === 'follow_up_applied')).toBe(true)
    expect(events.some((e) => e.type === 'assistant_message' && e.content === 'steered reply')).toBe(
      true
    )
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(call).toBeGreaterThanOrEqual(2)

    const messages = loadMessages(workspace, runId)
    expect(messages.some((m) => m.role === 'user' && m.content === 'change course')).toBe(true)
  })

  it('soft-interrupts in-flight tools, applies follow-ups, then continues to done', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 't1', name: 'read', arguments: '{"path":"README.md"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'steered after tool interrupt' }
      yield { type: 'done', stopReason: 'stop' }
    })

    vi.mocked(executeTool).mockImplementation(
      async (_name: string, _args: string, _workspace: string, signal: AbortSignal) => {
        while (!signal.aborted) {
          await new Promise((r) => setTimeout(r, 5))
        }
        throw new DOMException('Aborted', 'AbortError')
      }
    )

    const runId = 'follow-up-during-tool'
    const events: Array<{
      type: string
      status?: string
      content?: string
      toolCallId?: string
    }> = []
    let toolStarted = false

    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'start' }],
      workspacePath: workspace
    })) {
      events.push(ev)
      if (ev.type === 'tool_start' && ev.toolCallId === 't1') {
        toolStarted = true
        enqueueFollowUp(runId, { role: 'user', content: 'change during tool' })
      }
    }

    expect(toolStarted).toBe(true)
    expect(events.some((e) => e.type === 'follow_up_applied')).toBe(true)
    expect(
      events.some(
        (e) =>
          e.type === 'tool_result' &&
          e.toolCallId === 't1' &&
          e.content === 'Interrupted'
      )
    ).toBe(true)
    expect(
      events.some((e) => e.type === 'assistant_message' && e.content === 'steered after tool interrupt')
    ).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(call).toBeGreaterThanOrEqual(2)

    const messages = loadMessages(workspace, runId)
    expect(messages.some((m) => m.role === 'user' && m.content === 'change during tool')).toBe(true)
    expect(
      messages.some((m) => m.role === 'tool' && m.toolCallId === 't1' && m.content === 'Interrupted')
    ).toBe(true)
  })

  it('drains a follow-up enqueued during the final flush window before done', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'text', text: 'almost done' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield { type: 'text', text: 'after steer' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'follow-up-before-done'
    const events: Array<{ type: string; status?: string }> = []

    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'start' }],
      workspacePath: workspace
    })) {
      events.push(ev)
      // Mimic a follow-up landing after the model finished but before terminal done.
      if (ev.type === 'assistant_message' && call === 1) {
        enqueueFollowUp(runId, { role: 'user', content: 'one more thing' })
      }
    }

    expect(events.some((e) => e.type === 'follow_up_applied')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(call).toBeGreaterThanOrEqual(2)
    const messages = loadMessages(workspace, runId)
    expect(messages.some((m) => m.role === 'user' && m.content === 'one more thing')).toBe(true)
  })
})
