import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-resume-${process.pid}-${Date.now()}`)

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

const assembleContextMock = vi.fn(async (input: {
  messages: unknown[]
  priorCompaction?: unknown
}) => ({
  messages: input.messages,
  system: 'system',
  estimatedTokens: 100,
  layers: { system: 10, history: 50, tools: 20, buffer: 20 },
  contextShrunk: false,
  anthropicNative: undefined,
  compaction: null
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: (input: Parameters<typeof assembleContextMock>[0]) => assembleContextMock(input),
    ensureMemoryLayout: () => undefined
  }
})

const streamChat = vi.fn()

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
        supportsTools: false,
        supportsVision: false
      }
    ]
  })
}))

import { runAgent } from '@main/agent/loop'
import { isActive, registerRunAbort, resetActiveRunsForTests } from '@main/agent/runRegistry'
import {
  appendMessage,
  createRun,
  flushMessageAppends,
  flushStatusWrites,
  loadCompaction,
  loadMessages,
  loadStatus,
  saveCompaction,
  updateStatus
} from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'

describe('runAgent session continuation', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-resume-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    assembleContextMock.mockClear()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('clears active state after a turn completes', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
    })

    const runId = 'session-run'
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      // drain
    }

    expect(isActive(runId)).toBe(false)
  })

  it('resumes the same runId after the previous turn completes', async () => {
    const runId = 'session-run'

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      // drain
    }

    expect(isActive(runId)).toBe(false)
    const runDir = resolveRunDir(workspace, runId)
    const priorStep = loadStatus(runDir)?.step ?? 0
    await flushStatusWrites(runDir)
    await updateStatus(runDir, { status: 'error', error: 'stale failure' }, { sync: true })

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'file list' }
    })

    // chatStart pre-registers before runAgent (startup cancel race).
    registerRunAbort(runId, workspace)

    const events: Array<{ type: string; status?: string; code?: string; message?: string }> = []
    for await (const ev of runAgent({
      runId,
      incremental: true,
      newMessages: [{ role: 'user', content: 'list all the files' }],
      workspacePath: workspace,
      resume: true
    })) {
      events.push(ev)
    }

    expect(events.some((e) => e.type === 'error' && e.code === 'RUN_ACTIVE')).toBe(false)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(isActive(runId)).toBe(false)

    const messages = loadMessages(workspace, runId)
    expect(messages).toHaveLength(4)
    expect(messages[2]).toMatchObject({ role: 'user', content: 'list all the files' })
    expect(messages[3]).toMatchObject({ role: 'assistant', content: 'file list' })
    expect(loadStatus(runDir)).toMatchObject({
      status: 'done',
      step: priorStep + 1
    })
    expect(loadStatus(runDir)?.error).toBeUndefined()
  })

  it('loads persisted compaction when resuming a run', async () => {
    const runId = 'compact-resume'
    const runDir = createRun(workspace, runId, 'goal')
    const record = {
      summary: '## Session Intent\nPrior work summary',
      createdAt: new Date().toISOString(),
      tokenEstimate: 120
    }
    saveCompaction(runDir, record)

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'ok' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'continue' }],
      workspacePath: workspace
    })) {
      // drain
    }

    expect(loadCompaction(runDir)).toEqual(record)
    expect(assembleContextMock).toHaveBeenCalled()
    const input = assembleContextMock.mock.calls[0]?.[0] as { priorCompaction?: unknown }
    expect(input.priorCompaction).toEqual(record)
  })

  it('ignores stale client messages and merges only newMessages from disk', async () => {
    const runId = 'disk-first'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'first' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'real first' }],
      workspacePath: workspace
    })) {
      // drain
    }

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'second' }
    })
    registerRunAbort(runId, workspace)

    for await (const _ev of runAgent({
      runId,
      // Stale/wrong full history must not rewrite disk.
      messages: [{ role: 'user', content: 'stale rewrite' }],
      incremental: true,
      newMessages: [{ role: 'user', content: 'follow up' }],
      workspacePath: workspace,
      resume: true
    })) {
      // drain
    }

    const messages = loadMessages(workspace, runId)
    expect(messages.map((m) => m.content)).toEqual([
      'real first',
      'first',
      'follow up',
      'second'
    ])
    expect(messages.some((m) => m.content === 'stale rewrite')).toBe(false)
  })

  it('dedupes newMessages already persisted on disk', async () => {
    const runId = 'dedupe-resume'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      // drain
    }

    // Simulate chatStart having already appended the follow-up user turn.
    const runDir = resolveRunDir(workspace, runId)
    appendMessage(runDir, { role: 'user', content: 'list files' })
    await flushMessageAppends(runDir)

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'listed' }
    })
    registerRunAbort(runId, workspace)

    for await (const _ev of runAgent({
      runId,
      incremental: true,
      newMessages: [{ role: 'user', content: 'list files' }],
      workspacePath: workspace,
      resume: true
    })) {
      // drain
    }

    const messages = loadMessages(workspace, runId)
    const userTurns = messages.filter((m) => m.role === 'user' && m.content === 'list files')
    expect(userTurns).toHaveLength(1)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'listed' })
  })

  it('dedupes the full persisted prefix of newMessages', async () => {
    const runId = 'dedupe-prefix-resume'
    const runDir = createRun(workspace, runId, 'goal')
    appendMessage(runDir, { role: 'user', content: 'first replayed turn' })
    appendMessage(runDir, { role: 'user', content: 'second replayed turn' })
    await flushMessageAppends(runDir)

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'continued once' }
    })
    registerRunAbort(runId, workspace)

    for await (const _ev of runAgent({
      runId,
      incremental: true,
      newMessages: [
        { role: 'user', content: 'first replayed turn' },
        { role: 'user', content: 'second replayed turn' },
        { role: 'user', content: 'new turn' }
      ],
      workspacePath: workspace,
      resume: true
    })) {
      // drain
    }

    const messages = loadMessages(workspace, runId)
    expect(messages.filter((m) => m.content === 'first replayed turn')).toHaveLength(1)
    expect(messages.filter((m) => m.content === 'second replayed turn')).toHaveLength(1)
    expect(messages.filter((m) => m.content === 'new turn')).toHaveLength(1)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'continued once' })
  })

  it('clamps a corrupt foldedMessages watermark so the latest turn stays visible', async () => {
    const runId = 'watermark-clamp'
    const runDir = createRun(workspace, runId, 'goal')
    appendMessage(runDir, { role: 'user', content: 'old' })
    appendMessage(runDir, { role: 'assistant', content: 'prior' })
    await flushMessageAppends(runDir)
    saveCompaction(runDir, {
      summary: 'prior summary',
      createdAt: new Date().toISOString(),
      tokenEstimate: 50,
      foldedMessages: 99
    })

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'continued' }
    })
    registerRunAbort(runId, workspace)

    for await (const _ev of runAgent({
      runId,
      incremental: true,
      newMessages: [{ role: 'user', content: 'keep me' }],
      workspacePath: workspace,
      resume: true
    })) {
      // drain
    }

    expect(assembleContextMock).toHaveBeenCalled()
    const input = assembleContextMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>
    }
    expect(input.messages.some((m) => m.content === 'keep me')).toBe(true)
    expect(input.messages).not.toHaveLength(0)

    const clamped = loadCompaction(runDir)
    expect(clamped?.foldedMessages).toBe(2)
    expect(clamped?.summary).toBe('prior summary')
  })

  it('persists server-side compaction from a stream done chunk', async () => {
    const runId = 'server-compact'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'folding' }
      yield { type: 'done', compaction: '## Server compaction\nNew intent' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' }
      ],
      workspacePath: workspace
    })) {
      // drain
    }

    const record = loadCompaction(resolveRunDir(workspace, runId))
    expect(record).not.toBeNull()
    expect(record?.summary).toContain('Server compaction')
  })

  it('persists foldedMessages on compaction emit when context shrinks', async () => {
    const runId = 'fold-persist'
    assembleContextMock.mockImplementationOnce(async (input: { messages: unknown[] }) => ({
      messages: input.messages.slice(-1),
      system: 'system',
      estimatedTokens: 80,
      layers: { system: 10, history: 30, tools: 20, buffer: 20 },
      contextShrunk: true,
      anthropicNative: undefined,
      compaction: {
        summary: '## Session Intent\nFolded prior turns',
        createdAt: new Date().toISOString(),
        tokenEstimate: 40
      }
    }))

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'after fold' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' }
      ],
      workspacePath: workspace
    })) {
      // drain
    }

    const record = loadCompaction(resolveRunDir(workspace, runId))
    expect(record?.foldedMessages).toBe(2)
    expect(record?.summary).toContain('Folded prior turns')
  })
})

