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

  it('continues past 4 mixed steps (probe fails + todo_write succeeds each step)', async () => {
    // Run 1de9344a pathology: every step mixed a failing environment probe with
    // successful todo/memory calls, yet each step was charged as all-failed and
    // the run died on LOOP_SAFETY at step 63. Mixed steps make progress — the
    // failure streak must reset.
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call > 5) {
        yield { type: 'text', text: 'environment mapped, proceeding' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield {
        type: 'tool_call',
        toolCall: { id: `t${call}`, name: 'terminal', arguments: `{"command":"probe ${call}"}` }
      }
      yield {
        type: 'tool_call',
        toolCall: { id: `w${call}`, name: 'todo_write', arguments: '{"todos":[{"id":"1","content":"x","status":"in_progress"}]}' }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockImplementation(async (name: string) => {
      if (name === 'terminal') {
        return { ok: false, summary: 'probe failed', content: 'stderr:\nnot recognized\nexit_code: 1' }
      }
      return { ok: true, summary: 'todos', content: '1 task' }
    })

    const runId = 'safety-mixed-steps'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(6)
    expectNoLoopSafetyStop(events)
    const persisted = readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    expect(persisted).not.toContain('"code":"LOOP_SAFETY"')
  })

  it('still stops when every step fails outright (guard intact)', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call > 6) {
        yield { type: 'text', text: 'giving up' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield {
        type: 'tool_call',
        toolCall: { id: `f${call}`, name: 'terminal', arguments: `{"command":"cargo test --release ${call}"}` }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockResolvedValue({
      ok: false,
      summary: 'build failed',
      content: 'stderr:\nerror: could not compile\nexit_code: 101'
    })

    const runId = 'safety-all-fail-still-stops'
    const events = await collect(runId, workspace)

    const loopStop = events.find((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')
    expect(loopStop).toBeTruthy()
    expect(String(loopStop?.message)).toContain('failed 4 steps in a row')
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
  })

  it(
    'runaway 500-step guard emits a visible LOOP_SAFETY error and a fresh continue resets the step budget',
    { timeout: 120_000 },
    async () => {
      // Run 6265fa90 (2026-09-01): the runaway guard fired with NO error event
      // (bare "Run failed" in the UI) and every app restart re-fired it ~200ms
      // in — status running → error, no steps, no provider call — because the
      // restored step counter sat at the ceiling and the guard checked before
      // any provider call. The guard's own message promises "Send continue to
      // keep going"; that must actually continue.
      let call = 0
      streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
        call += 1
        if (call <= 500) {
          yield {
            type: 'tool_call',
            toolCall: { id: `c${call}`, name: 'read', arguments: `{"path":"f${call}.ts"}` }
          }
          yield { type: 'done', stopReason: 'tool_calls' }
          return
        }
        yield { type: 'text', text: 'resumed and finished' }
        yield { type: 'done', stopReason: 'stop' }
      })
      executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

      const runId = 'safety-runaway-resume'
      const first = await collect(runId, workspace)

      const guard = first.find((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')
      expect(guard).toBeTruthy()
      expect(String(guard?.message)).toContain('500 agent steps')
      expect(first.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
      // The reason must be persisted so it survives an app restart.
      const runDir = resolveRunDir(workspace, runId)
      const persisted = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
      expect(persisted).toContain('"code":"LOOP_SAFETY"')
      expect(persisted).toContain('runaway-loop guard')
      const statusRaw = JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8')) as {
        step: number
      }
      expect(statusRaw.step).toBeGreaterThanOrEqual(500)

      const resumed = await collect(runId, workspace, { resume: true })
      // Without the step-budget reset the resumed run would hit the guard
      // before streaming anything: no new stream call and a LOOP_SAFETY error.
      expect(resumed.some((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')).toBe(false)
      expect(resumed.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
      expect(streamChat).toHaveBeenCalledTimes(501)
    }
  )
})
