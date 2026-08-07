import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-userdata-${process.pid}-${Date.now()}`)

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

import {
  appendMessage,
  listRuns,
  interruptOrphanRuns,
  loadEvents,
  loadMessages,
  createRun,
  resumeRun,
  syncMessages
} from '@main/agent/state'
import { readTodos, toolTodoWrite } from '@main/agent/tools/todo'
import { resolveRunDir } from '@main/storage/paths'
import { registerRunAbort, clearRunAbort } from '@main/agent/runRegistry'

function writeStatus(
  dir: string,
  status: { status: string; step?: number; updatedAt: string; goal?: string; error?: string; workspacePath?: string }
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2), 'utf8')
}

describe('listRuns / interruptOrphanRuns', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-ws-${process.pid}-${Date.now()}-${Math.random()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(userData, 'sessions'), { recursive: true })
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('lists workspace runs only', async () => {
    writeStatus(resolveRunDir(workspace, 'ws-run'), {
      status: 'done',
      updatedAt: '2026-01-03T00:00:00.000Z',
      goal: 'workspace',
      workspacePath: workspace
    })
    writeStatus(join(userData, 'sessions', 'session-run'), {
      status: 'done',
      updatedAt: '2026-01-02T00:00:00.000Z',
      goal: 'session'
    })

    const result = await listRuns(workspace)
    expect(result.runs.map((r) => r.runId)).toEqual(['ws-run'])
    expect(result.capped).toBe(false)
  })

  it('reports capped when more than 30 runs exist', async () => {
    for (let i = 0; i < 31; i++) {
      const stamp = String(i).padStart(2, '0')
      writeStatus(resolveRunDir(workspace, `run-${stamp}`), {
        status: 'done',
        updatedAt: `2026-01-01T00:${stamp}:00.000Z`,
        goal: `run ${stamp}`,
        workspacePath: workspace
      })
    }

    const result = await listRuns(workspace)
    expect(result.runs).toHaveLength(30)
    expect(result.capped).toBe(true)
  })

  it('loads messages and skips invalid jsonl lines', () => {
    const dir = resolveRunDir(workspace, 'msg-run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'messages.jsonl'),
      [
        JSON.stringify({ role: 'user', content: 'hello' }),
        '{not json',
        JSON.stringify({ role: 'bogus' }),
        JSON.stringify({ role: 'assistant', content: 'hi' })
      ].join('\n'),
      'utf8'
    )

    const messages = loadMessages(workspace, 'msg-run')
    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' }
    ])
  })

  it('reads persisted events and injects legacy runId', () => {
    const dir = resolveRunDir(workspace, 'event-run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        JSON.stringify({ at: '2026-01-01T00:00:00.000Z', event: { type: 'status', status: 'running' } }),
        JSON.stringify({
          at: '2026-01-01T00:00:01.000Z',
          event: { type: 'tool_start', name: 'read', runId: 'event-run' }
        })
      ].join('\n'),
      'utf8'
    )

    const events = loadEvents(dir, 'event-run')
    expect(events).toHaveLength(2)
    expect(events[0]?.event).toMatchObject({
      type: 'status',
      status: 'running',
      runId: 'event-run'
    })
    expect(events[1]?.event).toMatchObject({ type: 'tool_start', name: 'read', runId: 'event-run' })
  })

  it('marks orphan running status as cancelled on interrupt', async () => {
    const wsDir = resolveRunDir(workspace, 'orphan-ws')
    writeStatus(wsDir, {
      status: 'running',
      step: 1,
      invokeId: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      goal: 'also left',
      workspacePath: workspace
    })
    writeStatus(resolveRunDir(workspace, 'finished'), {
      status: 'done',
      updatedAt: '2026-01-01T00:00:00.000Z',
      workspacePath: workspace
    })

    const count = await interruptOrphanRuns([workspace])
    expect(count).toBe(1)

    const wsStatus = JSON.parse(readFileSync(join(wsDir, 'status.json'), 'utf8')) as {
      status: string
      error?: string
      invokeId?: number
    }
    const finished = JSON.parse(
      readFileSync(join(resolveRunDir(workspace, 'finished'), 'status.json'), 'utf8')
    ) as { status: string }

    expect(wsStatus.status).toBe('cancelled')
    expect(wsStatus.error).toMatch(/Interrupted/)
    expect(wsStatus.invokeId).toBe(3)
    expect(finished.status).toBe('done')

    const wsEvents = loadEvents(wsDir, 'orphan-ws')
    expect(wsEvents).toHaveLength(1)
    expect(wsEvents[0]?.event).toMatchObject({
      type: 'status',
      status: 'cancelled',
      runId: 'orphan-ws',
      invokeId: 3
    })
  })

  it('writes tool_result stubs for unfinished tool calls on interrupt', async () => {
    const runId = 'orphan-tools'
    const dir = resolveRunDir(workspace, runId)
    writeStatus(dir, {
      status: 'running',
      step: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
      goal: 'left mid-tool',
      workspacePath: workspace
    })
    syncMessages(dir, [
      { role: 'user', content: 'audit' },
      {
        role: 'assistant',
        content: 'launching',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: '{"path":"a.ts"}' }]
      }
    ])

    const count = await interruptOrphanRuns([workspace])
    expect(count).toBe(1)

    const messages = loadMessages(workspace, runId)
    expect(messages).toContainEqual({
      role: 'tool',
      toolCallId: 'tc1',
      toolName: 'read',
      content: 'Cancelled',
      ok: false
    })

    const events = loadEvents(dir, runId)
    expect(events.some((row) => row.event.type === 'tool_result')).toBe(true)
  })

  it('cancels in-progress todo tasks on interrupt', async () => {
    const runId = 'orphan-todo'
    const dir = resolveRunDir(workspace, runId)
    writeStatus(dir, {
      status: 'running',
      step: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
      goal: 'left mid-todo',
      workspacePath: workspace
    })
    syncMessages(dir, [
      { role: 'user', content: 'audit' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool',
        toolCallId: 'todo1',
        toolName: 'todo_write',
        content: '0/5 complete\n[~] Audit core library files\n[ ] Audit API routes'
      }
    ])
    toolTodoWrite(dir, [
      { id: '1', content: 'Audit core library files', status: 'in_progress' },
      { id: '2', content: 'Audit API routes', status: 'pending' }
    ])

    const count = await interruptOrphanRuns([workspace])
    expect(count).toBe(1)

    const messages = loadMessages(workspace, runId)
    const todoMessage = messages.find((message) => message.role === 'tool' && message.toolName === 'todo_write')
    expect(todoMessage?.content).toContain('[-] Audit core library files')
    expect(todoMessage?.content).not.toContain('[~]')
    expect(readTodos(dir).find((todo) => todo.id === '1')?.status).toBe('cancelled')
  })

  it('does not interrupt runs that are still active in memory', async () => {
    const liveId = 'live-run'
    const liveDir = resolveRunDir(workspace, liveId)
    writeStatus(liveDir, {
      status: 'running',
      step: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      goal: 'still going',
      workspacePath: workspace
    })
    registerRunAbort(liveId, workspace)
    try {
      const count = await interruptOrphanRuns([workspace])
      expect(count).toBe(0)
      const status = JSON.parse(readFileSync(join(liveDir, 'status.json'), 'utf8')) as {
        status: string
      }
      expect(status.status).toBe('running')
    } finally {
      clearRunAbort(liveId)
    }
  })

  it('resumeRun updates status without wiping messages or events', async () => {
    const runId = 'resume-run'
    const dir = createRun(workspace, runId, 'initial goal')
    const userMsg = { role: 'user' as const, content: 'hello' }
    const assistantMsg = { role: 'assistant' as const, content: 'hi there' }
    syncMessages(dir, [userMsg, assistantMsg])
    writeFileSync(
      join(dir, 'events.jsonl'),
      `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', event: { type: 'status', status: 'done' } })}\n`,
      'utf8'
    )
    writeFileSync(join(dir, 'contract.md'), '# Run contract\n\n## Goal\n\ninitial goal\n', 'utf8')

    const resumedDir = await resumeRun(workspace, runId)
    expect(resumedDir).toBe(dir)

    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      status: string
    }
    expect(status.status).toBe('running')
    expect(loadMessages(workspace, runId)).toEqual([userMsg, assistantMsg])
    expect(readFileSync(join(dir, 'contract.md'), 'utf8')).toContain('initial goal')
    expect(loadEvents(dir, runId)).toHaveLength(1)
  })

  it('repairs orphan tool results before a queued follow-up and clears stale errors', async () => {
    const runId = 'resume-orphan'
    const dir = createRun(workspace, runId, 'repair')
    syncMessages(dir, [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'read', arguments: '{"path":"a.ts"}' }]
      }
    ])
    writeStatus(dir, {
      status: 'error',
      step: 7,
      updatedAt: '2026-01-01T00:00:00.000Z',
      error: 'old failure',
      workspacePath: workspace
    })
    appendMessage(dir, { role: 'user', content: 'continue' })

    await resumeRun(workspace, runId)

    expect(loadMessages(workspace, runId)).toEqual([
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'tool',
        toolCallId: 'tool-1',
        toolName: 'read',
        content: 'Cancelled',
        ok: false
      },
      { role: 'user', content: 'continue' }
    ])
    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      status: string
      step: number
      error?: string
    }
    expect(status).toMatchObject({ status: 'running', step: 7 })
    expect(status.error).toBeUndefined()
  })

  it('reconciles stale running runs on listRuns', async () => {
    const staleAt = new Date(Date.now() - 3 * 60_000).toISOString()
    writeStatus(resolveRunDir(workspace, 'stale-run'), {
      status: 'running',
      updatedAt: staleAt,
      goal: 'stale',
      workspacePath: workspace
    })
    writeStatus(resolveRunDir(workspace, 'fresh-run'), {
      status: 'running',
      updatedAt: new Date().toISOString(),
      goal: 'fresh',
      workspacePath: workspace
    })

    const result = await listRuns(workspace)
    expect(result.runs.find((r) => r.runId === 'stale-run')?.status).toBe('cancelled')
    expect(result.runs.find((r) => r.runId === 'fresh-run')?.status).toBe('running')
  })

  it('skips in-memory active runs during stale reconciliation', async () => {
    const staleAt = new Date(Date.now() - 3 * 60_000).toISOString()
    writeStatus(resolveRunDir(workspace, 'live-run'), {
      status: 'running',
      updatedAt: staleAt,
      goal: 'live',
      workspacePath: workspace
    })
    registerRunAbort('live-run', new AbortController(), workspace, 1)

    const result = await listRuns(workspace)
    expect(result.runs.find((r) => r.runId === 'live-run')?.status).toBe('running')

    clearRunAbort('live-run')
  })

  it('syncMessages rewrites messages.jsonl from client history', () => {
    const runId = 'sync-run'
    const dir = createRun(workspace, runId, 'sync test')
    const messages = [
      { role: 'user' as const, content: 'one' },
      { role: 'assistant' as const, content: 'two' },
      { role: 'user' as const, content: 'three' }
    ]

    syncMessages(dir, messages)

    expect(loadMessages(workspace, runId)).toEqual(messages)
  })
})
