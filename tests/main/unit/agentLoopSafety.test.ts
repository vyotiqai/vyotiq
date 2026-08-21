import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'
import {
  MAX_IDENTICAL_STEP_STREAK
} from '@main/agent/loopPolicy'

const userData = join(tmpdir(), `vyotiq-loopsafety-${process.pid}-${Date.now()}`)

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
    telemetryEnabled: false
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

import { runAgent } from '@main/agent/loop'
import { enqueueFollowUp, resetActiveRunsForTests } from '@main/agent/runRegistry'

type CapturedEvent = {
  type: string
  status?: string
  code?: string
  message?: string
  ids?: string[]
  reason?: string
}

async function collect(
  runId: string,
  workspace: string,
  opts?: { resume?: boolean }
): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = []
  for await (const ev of runAgent({
    runId,
    messages: [{ role: 'user', content: 'keep using tools' }],
    workspacePath: workspace,
    ...(opts?.resume ? { resume: true } : {})
  })) {
    events.push(ev as CapturedEvent)
  }
  return events
}

function expectNoLoopSafetyStop(events: CapturedEvent[]): void {
  expect(events.some((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')).toBe(false)
  expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(false)
  expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
}

describe('runAgent LOOP_SAFETY integration', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-loopsafety-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockClear()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('continues after the same tool call repeats beyond the former identical streak', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call > MAX_IDENTICAL_STEP_STREAK + 2) {
        yield { type: 'text', text: 'finished after repeating tools' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield {
        type: 'tool_call',
        toolCall: { id: `c${call}`, name: 'read', arguments: '{"path":"a.ts"}' }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'safety-identical-streak'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(MAX_IDENTICAL_STEP_STREAK + 3)
    expect(executeTool).toHaveBeenCalledTimes(MAX_IDENTICAL_STEP_STREAK + 2)
    expectNoLoopSafetyStop(events)

    const persisted = readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    expect(persisted).not.toContain('"code":"LOOP_SAFETY"')
  })

  it('auto-continues truncated text then finishes without LOOP_SAFETY', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call <= 3) {
        yield { type: 'text', text: 'partial…' }
        yield { type: 'done', stopReason: 'length' }
        return
      }
      yield { type: 'text', text: 'complete' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'safety-identical-reset'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(4)
    expectNoLoopSafetyStop(events)
    expect(events.some((e) => e.type === 'incomplete' && e.reason === 'truncated')).toBe(true)
  })

  it('does not drop queued follow-ups on a repeating tool streak', async () => {
    const runId = 'safety-follow-up-dropped'
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === MAX_IDENTICAL_STEP_STREAK) {
        const queued = enqueueFollowUp(runId, { role: 'user', content: 'late steer' })
        expect(queued.ok).toBe(true)
      }
      if (call > MAX_IDENTICAL_STEP_STREAK + 2) {
        yield { type: 'text', text: 'done' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield {
        type: 'tool_call',
        toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const events = await collect(runId, workspace)
    expect(events.some((e) => e.type === 'follow_up_dropped')).toBe(false)
    expectNoLoopSafetyStop(events)
  })
})
