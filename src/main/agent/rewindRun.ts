import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import type { AgentEvent, ChatMessage, PersistedEvent } from '../../shared/ipc'
import { rewindWritesFrom, type RewindWritesResult } from './checkpoints'
import {
  loadCompaction,
  loadEventsAsync,
  loadMessagesAsync,
  saveCompaction,
  syncEventsAsync,
  syncMessagesAsync,
  updateStatus
} from './state'
import { resolveRunDir } from '../storage/paths'
import { clearFollowUps } from './runRegistry'
import { logger } from '../../shared/logger'

export type PrepareRewindResult = {
  messages: ChatMessage[]
  writes: RewindWritesResult
}

function keptToolCallIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) ids.add(tc.id)
    }
    if (m.role === 'tool' && m.toolCallId) ids.add(m.toolCallId)
  }
  return ids
}

function eventToolCallId(event: AgentEvent): string | undefined {
  if ('toolCallId' in event && typeof event.toolCallId === 'string' && event.toolCallId) {
    return event.toolCallId
  }
  return undefined
}

/**
 * Truncate events to those that still belong to kept message history.
 * Cuts at the first event that references a dropped tool call or a rewound
 * write checkpoint.
 */
function truncateEvents(
  persisted: PersistedEvent[],
  keptIds: Set<string>,
  rewoundCheckpointIds: Set<string>
): AgentEvent[] {
  const kept: AgentEvent[] = []
  for (const row of persisted) {
    const ev = row.event
    if (!ev || typeof ev !== 'object' || !('type' in ev)) continue
    const agentEvent = ev as AgentEvent
    if (agentEvent.type === 'writes_checkpoint') {
      if (rewoundCheckpointIds.has(agentEvent.checkpointId)) break
      kept.push(agentEvent)
      continue
    }
    const toolId = eventToolCallId(agentEvent)
    if (toolId && !keptIds.has(toolId)) break
    kept.push(agentEvent)
  }
  return kept
}

/**
 * Restore workspace files and rewrite run persistence so the next invoke answers
 * the edited user message with history truncated after it.
 */
export async function prepareRewindAndReplaceUserMessage(input: {
  workspacePath: string
  runId: string
  editMessageIndex: number
  editedUserMessage: ChatMessage
}): Promise<PrepareRewindResult> {
  const { workspacePath, runId, editMessageIndex, editedUserMessage } = input
  const runDir = resolveRunDir(workspacePath, runId)
  if (!existsSync(runDir)) {
    throw new Error('Run not found')
  }

  clearFollowUps(runId)

  const diskMessages = await loadMessagesAsync(workspacePath, runId)
  if (editMessageIndex < 0 || editMessageIndex >= diskMessages.length) {
    throw new Error('editMessageIndex out of range')
  }
  if (diskMessages[editMessageIndex]?.role !== 'user') {
    throw new Error('editMessageIndex must point at a user message')
  }

  const writes = rewindWritesFrom(runDir, workspacePath, editMessageIndex)
  const rewoundIds = new Set(writes.checkpointIds)

  const prior = diskMessages.slice(0, editMessageIndex)
  const nextMessages: ChatMessage[] = [...prior, { ...editedUserMessage, role: 'user' }]
  await syncMessagesAsync(runDir, nextMessages)

  const persistedEvents = await loadEventsAsync(runDir, runId)
  const keptIds = keptToolCallIds(prior)
  const truncatedEvents = truncateEvents(persistedEvents, keptIds, rewoundIds)
  await syncEventsAsync(runDir, truncatedEvents)

  const compaction = loadCompaction(runDir)
  const folded = compaction?.foldedMessages ?? 0
  if (compaction && folded > nextMessages.length) {
    const path = join(runDir, 'compaction.json')
    if (existsSync(path)) {
      rmSync(path, { force: true })
    }
    logger.info('Cleared compaction watermark after rewind', {
      scope: 'agent',
      correlationId: runId,
      foldedMessages: folded,
      messageCount: nextMessages.length
    })
  } else if (compaction && folded > prior.length) {
    saveCompaction(runDir, { ...compaction, foldedMessages: prior.length })
  }

  await updateStatus(
    runDir,
    {
      status: 'done',
      error: undefined,
      consecutiveToolFailureSteps: 0
    },
    { sync: true }
  )

  return { messages: nextMessages, writes }
}
