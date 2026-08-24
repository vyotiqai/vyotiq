import type { WebContents } from 'electron'
import { IPC } from '../../shared/channels'
import {
  type AgentEvent,
  type AgentInteractionMode,
  type ChatMessage,
  needsYouDedupeKey,
  runDoneDedupeKey,
  runErrorDedupeKey
} from '../../shared/ipc'
import { isAbortError, formatError } from '../../shared/errors'
import { getMainWindow } from '../app/window'
import { isChatFixtureReplayEnabled, replayChatFixture } from '../e2e/chatFixtureReplay'
import {
  ChatEventBatcher,
  getChatEventBatchStats,
  resetChatEventBatchStats
} from '../ipc/streamBatch'
import { resolveRunDir } from '@main/storage/paths'
import { logger } from '../../shared/logger'
import { loadStatus } from './state'
import { hydrateFollowUpsFromDisk } from './followUpStore'
import { registerParentInstanceEmitter, registerRunIpcSender, handleInlineInstanceFinished } from './agentInstances'
import { runAgent } from './loop'
import {
  cancelPendingApprovals,
  registerApprovalSender
} from './toolApproval'
import {
  cancelPendingQuestions,
  registerQuestionSender
} from './agentQuestion'
import { publishLifecycleNotification } from '../notifications/bus'
import {
  markRunTurnComplete,
  takeLateFollowUpDropped,
  takeLateWriteCheckpoint
} from './runRegistry'

export function isTerminalAgentRunEvent(ev: AgentEvent): boolean {
  return (
    ev.type === 'error' ||
    (ev.type === 'status' &&
      (ev.status === 'cancelled' || ev.status === 'error' || ev.status === 'done'))
  )
}

function sendToWebContents(
  channel: string,
  payload: unknown,
  fallback: WebContents
): void {
  const current = getMainWindow()
  const target =
    current && !current.isDestroyed() && !current.webContents.isDestroyed()
      ? current.webContents
      : fallback.isDestroyed()
        ? null
        : fallback
  target?.send(channel, payload)
}

export function sendChatEventToRenderer(
  runId: string,
  event: AgentEvent,
  invokeId: number,
  wc: WebContents
): void {
  sendToWebContents(IPC.chatEvent, { ...event, invokeId }, wc)
}

export type StartAgentRunAgentInput = {
  runId: string
  workspacePath: string
  resume?: boolean
  mode?: AgentInteractionMode
  messages?: ChatMessage[]
  newMessages?: ChatMessage[]
  focusedFile?: string | null
}

export type StartAgentRunInput = {
  runId: string
  workspacePath: string
  invokeId: number
  controller: AbortController
  wc: WebContents
  agentInput: StartAgentRunAgentInput
}

export function startAgentRunInBackground(input: StartAgentRunInput): void {
  const { runId, workspacePath, invokeId, wc, controller, agentInput } = input
  const releaseIpcSender = registerRunIpcSender(runId, wc)

  ;(async () => {
    let terminalSent = false
    let terminalStatus: 'done' | 'error' | 'cancelled' | undefined
    const sendEvent = (ev: AgentEvent): void => {
      sendChatEventToRenderer(runId, ev, invokeId, wc)
    }
    const batcher = new ChatEventBatcher(sendEvent, { runId, workspacePath })
    const releaseApprovalSender = registerApprovalSender(runId, (request) => {
      batcher.flush()
      sendToWebContents(IPC.toolApprovalRequest, request, wc)
      publishLifecycleNotification({
        source: 'agent',
        kind: 'needs_you',
        title: 'Needs your input',
        body: request.summary.trim() || request.name,
        dedupeKey: needsYouDedupeKey(runId),
        action: { type: 'open_run', workspacePath, runId }
      })
    })
    const releaseQuestionSender = registerQuestionSender(runId, (request) => {
      batcher.flush()
      sendToWebContents(IPC.agentQuestionRequest, request, wc)
      const firstPrompt = request.questions[0]?.prompt ?? ''
      publishLifecycleNotification({
        source: 'agent',
        kind: 'needs_you',
        title: 'Needs your input',
        body: (request.title ?? firstPrompt).trim() || 'Waiting for your answer',
        dedupeKey: needsYouDedupeKey(runId),
        action: { type: 'open_run', workspacePath, runId }
      })
    })
    const releaseInstanceEmitter = registerParentInstanceEmitter(runId, (ev) => {
      batcher.push(ev)
    })
    try {
      const runSignal = controller.signal
      const eventStream = isChatFixtureReplayEnabled()
        ? replayChatFixture({
            runId,
            invokeId,
            workspacePath,
            runSignal
          })
        : runAgent(agentInput)
      for await (const ev of eventStream) {
        const terminal = isTerminalAgentRunEvent(ev as AgentEvent)
        if (terminal) terminalSent = true
        if (ev.type === 'status') {
          if (ev.status === 'done' || ev.status === 'error' || ev.status === 'cancelled') {
            terminalStatus = ev.status
          }
        }
        batcher.push(ev as AgentEvent)
        if (terminal) markRunTurnComplete(runId, invokeId)
      }
      const lateCheckpoint = takeLateWriteCheckpoint(runId)
      if (lateCheckpoint) batcher.push(lateCheckpoint)
      const lateDropped = takeLateFollowUpDropped(runId)
      if (lateDropped) batcher.push(lateDropped)
    } catch (err) {
      if (isAbortError(err)) {
        logger.warn('Chat run aborted', {
          scope: 'ipc',
          correlationId: runId
        })
        if (!terminalSent) {
          batcher.push({ type: 'status', runId, status: 'cancelled' })
          terminalStatus = 'cancelled'
        }
        return
      }
      const message = formatError(err)
      logger.error(`Chat run crashed: ${message}`, {
        scope: 'ipc',
        code: 'AGENT_LOOP',
        correlationId: runId,
        err
      })
      if (!terminalSent) {
        batcher.push({ type: 'error', runId, message, code: 'AGENT_LOOP' })
        batcher.push({ type: 'status', runId, status: 'error' })
        terminalStatus = 'error'
      }
    } finally {
      batcher.flush()
      batcher.dispose()
      if (process.env.VYOTIQ_PERF === '1') {
        const stats = getChatEventBatchStats()
        console.info('[vyotiq-perf] chatEvent batch', JSON.stringify(stats))
        if (stats.attachedRuns === 0) resetChatEventBatchStats()
      }
      releaseApprovalSender()
      releaseQuestionSender()
      releaseInstanceEmitter()
      releaseIpcSender()
      cancelPendingApprovals(runId, invokeId)
      cancelPendingQuestions(runId, invokeId)
      const persisted = loadStatus(resolveRunDir(workspacePath, runId))
      if (
        !persisted?.inlineInstance &&
        (terminalStatus === 'done' || terminalStatus === 'error')
      ) {
        const goal = persisted?.goal?.trim() ?? ''
        const failed = terminalStatus === 'error'
        publishLifecycleNotification({
          source: 'agent',
          kind: failed ? 'run_error' : 'run_done',
          title: failed
            ? goal
              ? `Failed: ${goal}`
              : 'Failed'
            : goal
              ? `Finished: ${goal}`
              : 'Finished',
          body: failed ? 'Agent run failed' : 'Agent run finished',
          dedupeKey: failed ? runErrorDedupeKey(runId) : runDoneDedupeKey(runId),
          action: { type: 'open_run', workspacePath, runId }
        })
      }
      if (persisted?.inlineInstance && persisted.parentRunId) {
        const finishStatus =
          terminalStatus ??
          (persisted.status === 'done' ||
          persisted.status === 'cancelled' ||
          persisted.status === 'error'
            ? persisted.status
            : 'error')
        await handleInlineInstanceFinished(workspacePath, runId, finishStatus)
      }
    }
  })().catch((err) => {
    logger.error('Background agent run failed after terminal cleanup', {
      scope: 'agent',
      correlationId: runId,
      error: formatError(err)
    })
  })
}

export function hydrateRunFollowUps(workspacePath: string, runId: string): void {
  hydrateFollowUpsFromDisk(resolveRunDir(workspacePath, runId), runId)
}
