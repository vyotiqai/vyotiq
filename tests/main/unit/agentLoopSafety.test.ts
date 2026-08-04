import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'
import {
  MAX_CONSECUTIVE_TOOL_FAILURE_STEPS,
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

import { runAgent } from '@main/agent/loop'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'

type CapturedEvent = {
  type: string
  status?: string
  code?: string
  message?: string
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

function expectLoopSafetyStop(
  events: CapturedEvent[],
  message: string
): void {
  const error = events.find((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')
  expect(error?.message).toBe(message)
  expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
  expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(false)
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

  it('stops with identical_step_streak after the same tool call repeats 6 steps', async () => {
    // Same name+args every step: fingerprint repeats, so the streak climbs to
    // MAX_IDENTICAL_STEP_STREAK on the 6th step — before that step's tools run.
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield {
        type: 'tool_call',
        toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'safety-identical-streak'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(MAX_IDENTICAL_STEP_STREAK)
    // The stopping step is detected right after streaming, before tool dispatch.
    expect(executeTool).toHaveBeenCalledTimes(MAX_IDENTICAL_STEP_STREAK - 1)
    expectLoopSafetyStop(
      events,
      `Stopped after the same tool call(s) repeated ${MAX_IDENTICAL_STEP_STREAK} steps in a row (likely a loop). Change approach, or start a new chat with fresh context.`
    )

    const persisted = readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    expect(persisted).toContain('"code":"LOOP_SAFETY"')
    expect(persisted).toContain('"status":"error"')
  })

  it('stops with tool_failure_streak after 8 consecutive failed tool steps', async () => {
    // Vary args per step so the identical-step guard never engages; every tool
    // fails, so the consecutive-failure counter climbs to the cap on step 8.
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      yield {
        type: 'tool_call',
        toolCall: { id: `c${call}`, name: 'read', arguments: `{"path":"f${call}.ts"}` }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockResolvedValue({ ok: false, summary: 'file', content: 'boom: read failed' })

    const runId = 'safety-failure-streak'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(MAX_CONSECUTIVE_TOOL_FAILURE_STEPS)
    // The failure streak is evaluated after tool execution, so all 8 steps ran tools.
    expect(executeTool).toHaveBeenCalledTimes(MAX_CONSECUTIVE_TOOL_FAILURE_STEPS)
    expectLoopSafetyStop(
      events,
      `Stopped after ${MAX_CONSECUTIVE_TOOL_FAILURE_STEPS} consecutive steps with a failed tool call. Inspect the last tool errors, adjust, and retry.`
    )

    const persisted = readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    expect(persisted).toContain('"code":"LOOP_SAFETY"')
    expect(persisted).toContain('"status":"error"')
  })

  it('does not re-emit LOOP_SAFETY on a follow-up invoke after failure streak stop', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      yield {
        type: 'tool_call',
        toolCall: { id: `c${call}`, name: 'read', arguments: `{"path":"f${call}.ts"}` }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockResolvedValue({ ok: false, summary: 'file', content: 'boom: read failed' })

    const runId = 'safety-follow-up-invoke'
    await collect(runId, workspace)

    streamChat.mockClear()
    executeTool.mockClear()
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'recovered' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const followUpEvents: CapturedEvent[] = []
    for await (const ev of runAgent({
      runId,
      incremental: true,
      newMessages: [{ role: 'user', content: 'try again' }],
      workspacePath: workspace,
      resume: true
    })) {
      followUpEvents.push(ev as CapturedEvent)
    }
    expect(followUpEvents.some((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')).toBe(false)

    const persisted = readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    const loopSafetyLines = persisted
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).event)
      .filter((event) => event?.code === 'LOOP_SAFETY')
    expect(loopSafetyLines).toHaveLength(1)
  })
})
