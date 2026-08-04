import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
import { prepareRewindAndReplaceUserMessage } from '@main/agent/rewindRun'
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
    cp1.recordPrior('a.txt', 'write')
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
    cp2.recordPrior('a.txt', 'write')
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
  })
})
