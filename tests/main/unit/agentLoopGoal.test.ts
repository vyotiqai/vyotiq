import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { formatGoalInvocation, GOAL_CONTINUE_PREFIX } from '@shared/goalRuntime'

const userData = join(tmpdir(), `vyotiq-goal-loop-${process.pid}-${Date.now()}`)

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
import { cancelRun, resetActiveRunsForTests } from '@main/agent/runRegistry'
import { loadMessages } from '@main/agent/state'
import { readGoal } from '@main/agent/runGoal'
import { resolveRunDir } from '@main/storage/paths'

describe('runAgent goal auto-continue', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-goal-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('continues once then waits after two no-tool finishes', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'still working' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'goal-auto-continue'
    const events: Array<{ type: string; status?: string }> = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: formatGoalInvocation('make CI green') }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(streamChat.mock.calls.length).toBe(2)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    const runDir = resolveRunDir(workspace, runId)
    const goal = readGoal(runDir)
    expect(goal?.status).toBe('active')
    expect(goal?.continueCount).toBe(1)
    const messages = loadMessages(workspace, runId)
    expect(messages.some((m) => m.role === 'user' && String(m.content).startsWith(GOAL_CONTINUE_PREFIX))).toBe(
      true
    )
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toContain('Two finishes without tools')
  })

  it('does not auto-continue in Plan mode', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'plan only' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'goal-plan'
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: formatGoalInvocation('make CI green') }],
      workspacePath: workspace,
      mode: 'plan'
    })) {
      // drain
    }
    expect(loadMessages(workspace, runId).some((m) => String(m.content).startsWith(GOAL_CONTINUE_PREFIX))).toBe(
      false
    )
    expect(readGoal(resolveRunDir(workspace, runId))?.status).toBe('active')
  })

  it('leaves the goal active when the run is aborted (quit must still resume)', async () => {
    streamChat.mockImplementation(async function* (req: { signal: AbortSignal }): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial' }
      while (!req.signal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const runId = 'goal-cancel'
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: formatGoalInvocation('make CI green') }],
      workspacePath: workspace
    })) {
      if (ev.type === 'text_delta') cancelRun(runId)
    }
    expect(readGoal(resolveRunDir(workspace, runId))?.status).toBe('active')
  })
})
