import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-rewind-ud-${process.pid}-${Date.now()}`)

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
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  resetWriteCheckpointsForTests
} from '@main/agent/checkpoints'
import { prepareRewindAndReplaceUserMessage, prepareRewindToUserMessage } from '@main/agent/rewindRun'
import {
  appendEvent,
  createRun,
  flushEventAppends,
  loadCompaction,
  loadEventsAsync,
  loadMessages,
  saveCompaction,
  syncMessagesAsync
} from '@main/agent/state'

let workspace: string
let runId: string
let runDir: string

beforeEach(() => {
  resetWriteCheckpointsForTests()
  workspace = join(tmpdir(), `vyotiq-rewind-ws-${process.pid}-${Date.now()}-${Math.random()}`)
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(userData, 'sessions'), { recursive: true })
  runId = `run-${Date.now()}`
  runDir = createRun(workspace, runId, 'test')
  writeFileSync(join(workspace, 'a.txt'), 'hello\n', 'utf8')
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
})

describe('prepareRewindAndReplaceUserMessage', () => {
  it('truncates messages/events and restores files for the edited turn', async () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      {
        role: 'assistant' as const,
        content: 'ok',
        toolCalls: [{ id: 't1', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 't1', toolName: 'edit', content: 'done', ok: true },
      { role: 'user' as const, content: 'second' },
      {
        role: 'assistant' as const,
        content: 'ok2',
        toolCalls: [{ id: 't2', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 't2', toolName: 'edit', content: 'done2', ok: true }
    ]
    await syncMessagesAsync(runDir, messages)

    const cp1 = beginWriteCheckpoint(runDir, workspace, 0)
    await cp1.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-first\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)
    appendEvent(runDir, {
      type: 'writes_checkpoint',
      runId,
      checkpointId: meta1!.id,
      files: meta1!.files
    })
    appendEvent(runDir, {
      type: 'tool_start',
      runId,
      toolCallId: 't1',
      name: 'edit',
      summary: 'a.txt'
    })

    const cp2 = beginWriteCheckpoint(runDir, workspace, 3)
    await cp2.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-second\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)
    appendEvent(runDir, {
      type: 'writes_checkpoint',
      runId,
      checkpointId: meta2!.id,
      files: meta2!.files
    })
    appendEvent(runDir, {
      type: 'tool_start',
      runId,
      toolCallId: 't2',
      name: 'edit',
      summary: 'a.txt'
    })
    await flushEventAppends(runDir)

    saveCompaction(runDir, {
      summary: 'old',
      createdAt: new Date().toISOString(),
      tokenEstimate: 10,
      foldedMessages: 5
    })

    const prepared = await prepareRewindAndReplaceUserMessage({
      workspacePath: workspace,
      runId,
      editMessageIndex: 3,
      editedUserMessage: { role: 'user', content: 'second-edited' }
    })

    expect(prepared.messages).toEqual([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: 'ok',
        toolCalls: [{ id: 't1', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 't1', toolName: 'edit', content: 'done', ok: true },
      { role: 'user', content: 'second-edited' }
    ])
    expect(loadMessages(workspace, runId)).toEqual(prepared.messages)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('after-first\n')
    expect(loadCompaction(runDir)).toBeNull()

    const events = await loadEventsAsync(runDir, runId)
    expect(
      events.some(
        (e) =>
          e.event.type === 'tool_start' &&
          (e.event as { toolCallId?: string }).toolCallId === 't2'
      )
    ).toBe(false)
    expect(
      events.some(
        (e) =>
          e.event.type === 'writes_checkpoint' &&
          (e.event as { checkpointId?: string }).checkpointId === meta2!.id
      )
    ).toBe(false)

    expect(existsSync(join(runDir, 'receipt.json'))).toBe(true)
    const receipt = JSON.parse(readFileSync(join(runDir, 'receipt.json'), 'utf8')) as {
      status: string
    }
    expect(receipt.status).toBe('done')
    expect(existsSync(join(runDir, 'trajectory.jsonl'))).toBe(true)
  })
})

describe('prepareRewindToUserMessage', () => {
  it('keeps original user text, truncates later turns, and restores files', async () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      {
        role: 'assistant' as const,
        content: 'ok',
        toolCalls: [{ id: 't1', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 't1', toolName: 'edit', content: 'done', ok: true },
      { role: 'user' as const, content: 'second' },
      {
        role: 'assistant' as const,
        content: 'ok2',
        toolCalls: [{ id: 't2', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 't2', toolName: 'edit', content: 'done2', ok: true }
    ]
    await syncMessagesAsync(runDir, messages)

    const cp1 = beginWriteCheckpoint(runDir, workspace, 0)
    await cp1.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-first\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)
    appendEvent(runDir, {
      type: 'writes_checkpoint',
      runId,
      checkpointId: meta1!.id,
      files: meta1!.files
    })

    const cp2 = beginWriteCheckpoint(runDir, workspace, 3)
    await cp2.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-second\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)
    appendEvent(runDir, {
      type: 'writes_checkpoint',
      runId,
      checkpointId: meta2!.id,
      files: meta2!.files
    })
    appendEvent(runDir, {
      type: 'tool_start',
      runId,
      toolCallId: 't2',
      name: 'edit',
      summary: 'a.txt'
    })
    await flushEventAppends(runDir)

    const prepared = await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 3
    })

    expect(prepared.messages).toEqual([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: 'ok',
        toolCalls: [{ id: 't1', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 't1', toolName: 'edit', content: 'done', ok: true },
      { role: 'user', content: 'second' }
    ])
    expect(loadMessages(workspace, runId)).toEqual(prepared.messages)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('after-first\n')

    const events = await loadEventsAsync(runDir, runId)
    expect(
      events.some(
        (e) =>
          e.event.type === 'tool_start' &&
          (e.event as { toolCallId?: string }).toolCallId === 't2'
      )
    ).toBe(false)
    expect(
      events.some(
        (e) =>
          e.event.type === 'writes_checkpoint' &&
          (e.event as { checkpointId?: string }).checkpointId === meta2!.id
      )
    ).toBe(false)

    expect(existsSync(join(runDir, 'receipt.json'))).toBe(true)
    const receipt = JSON.parse(readFileSync(join(runDir, 'receipt.json'), 'utf8')) as {
      status: string
    }
    expect(receipt.status).toBe('done')
    expect(existsSync(join(runDir, 'trajectory.jsonl'))).toBe(true)
  })

  it('clears orphaned todos.json when rewind drops every todo_write', async () => {
    const { toolTodoWrite } = await import('@main/agent/tools/todo')
    const messages = [
      { role: 'user' as const, content: 'plan work' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool' as const,
        toolCallId: 'todo1',
        toolName: 'todo_write',
        content: '0/1 complete',
        ok: true
      },
      { role: 'user' as const, content: 'follow-up' }
    ]
    await syncMessagesAsync(runDir, messages)
    toolTodoWrite(runDir, [{ id: '1', content: 'Ship', status: 'pending' }])
    expect(existsSync(join(runDir, 'todos.json'))).toBe(true)

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 0
    })

    expect(existsSync(join(runDir, 'todos.json'))).toBe(false)
    expect(loadMessages(workspace, runId)).toEqual([{ role: 'user', content: 'plan work' }])
  })

  it('keeps todos.json when rewind still retains a todo_write', async () => {
    const { toolTodoWrite } = await import('@main/agent/tools/todo')
    const messages = [
      { role: 'user' as const, content: 'plan work' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool' as const,
        toolCallId: 'todo1',
        toolName: 'todo_write',
        content: '0/1 complete\n[ ] (1) Ship',
        ok: true
      },
      { role: 'user' as const, content: 'follow-up' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'todo2', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool' as const,
        toolCallId: 'todo2',
        toolName: 'todo_write',
        content: '0/1 complete\n[ ] (1) Later task',
        ok: true
      }
    ]
    await syncMessagesAsync(runDir, messages)
    toolTodoWrite(runDir, [{ id: '1', content: 'Later task', status: 'pending' }])

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 3
    })

    expect(existsSync(join(runDir, 'todos.json'))).toBe(true)
    expect(loadMessages(workspace, runId).some((m) => m.toolName === 'todo_write')).toBe(true)
    const todos = JSON.parse(readFileSync(join(runDir, 'todos.json'), 'utf8')) as {
      todos: Array<{ content: string }>
    }
    expect(todos.todos[0]?.content).toBe('Ship')
  })

  it('does not truncate history when an undoable checkpoint restore fails', async () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: 'second' }
    ]
    await syncMessagesAsync(runDir, messages)

    const cp = beginWriteCheckpoint(runDir, workspace, 2)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-second\n', 'utf8')
    finalizeWriteCheckpoint(runDir)
    writeFileSync(join(workspace, 'a.txt'), 'user-edit\n', 'utf8')

    await expect(
      prepareRewindToUserMessage({
        workspacePath: workspace,
        runId,
        userMessageIndex: 2
      })
    ).rejects.toThrow(/history was not truncated/)

    expect(loadMessages(workspace, runId)).toEqual(messages)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('user-edit\n')
  })

  it('drops todos.json when the kept todo_write snapshot is unparseable', async () => {
    const { toolTodoWrite } = await import('@main/agent/tools/todo')
    const messages = [
      { role: 'user' as const, content: 'plan work' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool' as const,
        toolCallId: 'todo1',
        toolName: 'todo_write',
        content: 'garbled snapshot',
        ok: true
      },
      { role: 'user' as const, content: 'follow-up' }
    ]
    await syncMessagesAsync(runDir, messages)
    toolTodoWrite(runDir, [{ id: '1', content: 'Ship', status: 'pending' }])
    expect(existsSync(join(runDir, 'todos.json'))).toBe(true)

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 3
    })

    expect(existsSync(join(runDir, 'todos.json'))).toBe(false)
    expect(loadMessages(workspace, runId).some((m) => m.toolName === 'todo_write')).toBe(true)
  })

})
