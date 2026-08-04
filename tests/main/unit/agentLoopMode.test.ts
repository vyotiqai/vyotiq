import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'
import { DEFAULT_SETTINGS } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-mode-${process.pid}-${Date.now()}`)

const getSettings = vi.fn(() => ({
  ...DEFAULT_SETTINGS,
  provider: 'ollama' as const,
  model: 'qwen2.5',
  ollamaBaseUrl: 'http://127.0.0.1:11434'
}))

const getSecret = vi.fn(() => null as string | null)
const secretStatus = vi.fn(() => ({
  encryptionAvailable: true,
  keys: {} as Record<string, never>
}))
const hasStoredSecretBlob = vi.fn(() => false)

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
  getSettings: () => getSettings(),
  readLegacyWorkspacePath: () => null,
  clearSettingsCacheForTests: () => undefined
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => getSecret(),
  secretStatus: () => secretStatus(),
  hasStoredSecretBlob: () => hasStoredSecretBlob()
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
      overflow: false,
      anthropicNative: undefined,
      compaction: null
    }),
    ensureMemoryLayout: () => undefined
  }
})

const { streamChat, executeTool } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn()
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
      },
      {
        id: 'gpt-4o',
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

describe('runAgent mode and API key', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-mode-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    getSettings.mockReset()
    getSettings.mockImplementation(() => ({
      ...DEFAULT_SETTINGS,
      provider: 'ollama' as const,
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434'
    }))
    getSecret.mockReset()
    getSecret.mockReturnValue(null)
    secretStatus.mockReset()
    secretStatus.mockReturnValue({
      encryptionAvailable: true,
      keys: {} as Record<string, never>
    })
    hasStoredSecretBlob.mockReset()
    hasStoredSecretBlob.mockReturnValue(false)
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('Ask mode filters mutating tools from the provider tool list', async () => {
    let seenTools: string[] = []
    streamChat.mockImplementation(async function* (req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
      seenTools = (req.tools ?? []).map((t) => t.name)
      yield { type: 'text', text: 'read-only answer' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    for await (const _ of runAgent({
      runId: 'ask-filter',
      messages: [{ role: 'user', content: 'look around' }],
      workspacePath: workspace,
      mode: 'ask'
    })) {
      // drain
    }

    expect(seenTools).toContain('read')
    expect(seenTools).toContain('git_status')
    expect(seenTools).not.toContain('edit')
    expect(seenTools).not.toContain('terminal')
    expect(seenTools).not.toContain('delete')
    expect(seenTools).not.toContain('multi_edit')
    expect(existsSync(join(workspace, '.vyotiq'))).toBe(false)
  })

  it('Plan mode seeds plan.md under the run directory', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'drafting' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    const runId = 'plan-seed'
    for await (const _ of runAgent({
      runId,
      messages: [{ role: 'user', content: 'plan a feature' }],
      workspacePath: workspace,
      mode: 'plan'
    })) {
      // drain
    }

    const planPath = join(resolveRunDir(workspace, runId), 'plan.md')
    expect(existsSync(planPath)).toBe(true)
    const planBody = readFileSync(planPath, 'utf8')
    expect(planBody).toContain('# Plan')
    expect(planBody).toContain('## Goal')
    expect(planBody).toContain('## Approach')
    expect(existsSync(join(workspace, '.vyotiq'))).toBe(false)
  })

  it('defaults to Agent mode when mode is omitted', async () => {
    let seenTools: string[] = []
    streamChat.mockImplementation(async function* (req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
      seenTools = (req.tools ?? []).map((t) => t.name)
      yield { type: 'text', text: 'ok' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    const events: Array<{ type: string; status?: string }> = []
    for await (const ev of runAgent({
      runId: 'agent-default',
      messages: [{ role: 'user', content: 'implement' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(seenTools).toContain('edit')
    expect(seenTools).toContain('terminal')
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('exits early with PROVIDER_AUTH when a non-ollama API key is missing', async () => {
    getSettings.mockImplementation(() => ({
      ...DEFAULT_SETTINGS,
      provider: 'openai' as const,
      model: 'gpt-4o'
    }))
    getSecret.mockReturnValue(null)
    hasStoredSecretBlob.mockReturnValue(false)
    secretStatus.mockReturnValue({
      encryptionAvailable: true,
      keys: {} as Record<string, never>
    })

    const events: Array<{ type: string; status?: string; code?: string; message?: string }> = []
    for await (const ev of runAgent({
      runId: 'missing-key',
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(streamChat).not.toHaveBeenCalled()
    const err = events.find((e) => e.type === 'error')
    expect(err?.code).toBe('PROVIDER_AUTH')
    expect(err?.message).toMatch(/API key for openai is not set/i)
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
  })

  it('exits early with PROVIDER_AUTH when Ollama Cloud API key is missing', async () => {
    getSettings.mockImplementation(() => ({
      ...DEFAULT_SETTINGS,
      provider: 'ollama' as const,
      model: 'gpt-oss:120b',
      ollamaBaseUrl: 'https://ollama.com'
    }))
    getSecret.mockReturnValue(null)
    hasStoredSecretBlob.mockReturnValue(false)
    secretStatus.mockReturnValue({
      encryptionAvailable: true,
      keys: {} as Record<string, never>
    })

    const events: Array<{ type: string; status?: string; code?: string; message?: string }> = []
    for await (const ev of runAgent({
      runId: 'ollama-cloud-missing-key',
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(streamChat).not.toHaveBeenCalled()
    const err = events.find((e) => e.type === 'error')
    expect(err?.code).toBe('PROVIDER_AUTH')
    expect(err?.message).toBe(
      'Ollama Cloud (ollama.com) requires an API key. Add it in Settings → Providers, or switch the Ollama base URL to a local host (e.g. http://127.0.0.1:11434).'
    )
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
  })
})
