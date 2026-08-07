import type {
  AgentEvent,
  AgentInteractionMode,
  AttachedFile,
  ComposerSendExtras,
  ChatMessage,
  IncompleteReason,
  PersistedEvent,
  ToolApprovalDecision,
  ToolApprovalRequest,
  AgentQuestionAnswer,
  AgentQuestionRequest
} from '@shared/ipc'
import {
  emptyStepUsageTotals,
  mergeStepUsageTotals,
  stepUsageFromEvent,
  type StepUsageTotals
} from '@shared/utils/runTelemetry'
import {
  buildUserContent,
  contentDisplayText,
  contentImages,
  type MessageContent
} from '@shared/ipc'
import {
  appendAssistantWithTools,
  appendToolResult,
  messagesForNextTurn
} from '@shared/chatHistory'
import { isAgentEvent } from '@shared/eventUtils'
import { toLogErr } from '@shared/errors'
import { logger } from '@shared/logger'
import {
  messagesToUiItems,
  applyEventTimestamps,
  applyPersistedLiveTools,
  finalizeHydratedTranscript,
  mergeThinking,
  messageUiId,
  isToolShapedTextLeak,
  scrubStreamingAssistantToolLeak,
  stripToolShapedAssistantText,
  stripToolShapedAssistantTextForStream,
  uiAttachments,
  MAX_TOOL_PROGRESS_ENTRIES,
  type UiItem,
  type UiToolProgressEntry,
  type UiToolRow
} from '@shared/transcript'
import { isUnresolvedToolName, summarizeToolArgs } from '@shared/toolSummary'
import { toolPresentation } from '@renderer/features/chat/toolUi/meta'
import type { ContextUsageState } from '@shared/utils/contextUsage'
import {
  contextUsageFromEvent,
  summarizeContextUsageFromEvents
} from '@shared/utils/contextUsage'
import { sanitizeTerminalDisplayText } from '@shared/utils/terminalFormat'

const CHAT_START_MAX_ATTEMPTS = 3
const CHAT_START_RETRY_MS = 500
import {
  compactionTriggerFromRaw,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  allocateBudgetShares
} from '@shared/domain/contextBudget'
import { recordUiResume, recordUiSuspendSkip } from './chatUiPerf'

/** Tool progress is a live view, not a log; keep the recent tail. */
const CANCEL_RECOVERY_POLL_MS = 500
const CANCEL_RECOVERY_TIMEOUT_MS = 5_000
/** Background retry window when Stop fails but main keeps the run alive. */
const CANCEL_BACKGROUND_RETRY_MS = 45_000
const CANCEL_BACKGROUND_RETRY_EVERY_MS = 5_000

function withPresentationLock(tool: UiToolRow, name: string, argsPreview?: string): UiToolRow {
  const resolvedName = name && name !== 'tool' ? name : tool.name && tool.name !== 'tool' ? tool.name : ''
  // OpenAI often sends nameless first deltas; locking on placeholder "tool" would
  // permanently demote terminal/edit/etc. to compact.
  if (!resolvedName) return tool
  const preview = argsPreview ?? tool.argsPreview
  const summary = tool.summary
  if (tool.presentation && tool.name && tool.name !== 'tool') {
    // Recompute terminal when args/summary arrive so read-only commands can demote.
    if (resolvedName === 'terminal') {
      return { ...tool, presentation: toolPresentation(resolvedName, preview, summary) }
    }
    return tool
  }
  return { ...tool, presentation: toolPresentation(resolvedName, preview, summary) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Prefer event.code from main; fall back for older events without a code. */
function agentErrorCode(event: Extract<AgentEvent, { type: 'error' }>): string {
  if (event.code) return event.code
  return 'AGENT_LOOP'
}

function trailingToolGroupStart(items: UiItem[]): number {
  if (!items.length || items[items.length - 1].kind !== 'tool') return -1
  let start = items.length - 1
  while (start > 0 && items[start - 1].kind === 'tool') start--
  return start
}

function toolStretchEnd(items: UiItem[], start: number): number {
  let end = start
  while (end < items.length && items[end].kind === 'tool') end++
  return end
}

function trailingLiveToolGroupStart(items: UiItem[]): number {
  const start = trailingToolGroupStart(items)
  if (start < 0) return -1
  const first = items[start]
  if (first.kind !== 'tool' || first.groupTiming?.endedAt) return -1
  return start
}

/**
 * Only insert preamble text before live tools when tools arrived before any
 * assistant text in the same turn. If a finalized assistant precedes live tools,
 * new text belongs to the next turn and must stay after those tools.
 */
function shouldInsertTextBeforeLiveTools(items: UiItem[]): boolean {
  const liveStart = trailingLiveToolGroupStart(items)
  if (liveStart < 0) return false

  for (let i = liveStart - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'message' && item.role === 'assistant') {
      return item.streaming === true
    }
    if (item.kind === 'message' && item.role === 'user') {
      return true
    }
    if (item.kind === 'tool') {
      return false
    }
  }
  return true
}

function insertAssistantItem(items: UiItem[], next: Extract<UiItem, { kind: 'message' }>): UiItem[] {
  if (shouldInsertTextBeforeLiveTools(items)) {
    return insertBeforeTrailingTools(items, next)
  }
  const liveStart = trailingLiveToolGroupStart(items)
  if (liveStart >= 0) {
    const end = toolStretchEnd(items, liveStart)
    return [...items.slice(0, end), next, ...items.slice(end)]
  }
  return prependClosed(items, next)
}

function closeOpenGroupTimings(items: UiItem[], endedAt = Date.now()): UiItem[] {
  const start = trailingLiveToolGroupStart(items)
  if (start < 0) return items
  const first = items[start]
  if (first.kind !== 'tool') return items
  return items.map((item, i) => {
    if (i !== start || item.kind !== 'tool') return item
    return {
      ...item,
      groupTiming: {
        startedAt: item.groupTiming?.startedAt ?? endedAt,
        endedAt
      }
    }
  })
}

function prependClosed(items: UiItem[], next: UiItem | UiItem[]): UiItem[] {
  const closed = closeOpenGroupTimings(items)
  return Array.isArray(next) ? [...closed, ...next] : [...closed, next]
}

/**
 * Place same-turn preamble text before tools that arrived first and are still live.
 * Completed tool stretches stay chronological — next iteration text appends after them.
 */
function insertBeforeTrailingTools(items: UiItem[], next: UiItem | UiItem[]): UiItem[] {
  const batch = Array.isArray(next) ? next : [next]
  const liveStart = trailingLiveToolGroupStart(items)
  if (liveStart >= 0) {
    return [...items.slice(0, liveStart), ...batch, ...items.slice(liveStart)]
  }
  return [...closeOpenGroupTimings(items), ...batch]
}

/**
 * Where to splice a new tool row into the transcript.
 * Prefer the stretch after the latest user message when that user sits after the
 * last assistant (follow-up / continue) — otherwise tools land before the bubble
 * and inherit the previous turnIndex.
 */
function toolInsertIndex(items: UiItem[]): number {
  let lastUser = -1
  let lastAssistant = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'message') continue
    if (lastUser < 0 && item.role === 'user') lastUser = i
    if (lastAssistant < 0 && item.role === 'assistant') lastAssistant = i
    if (lastUser >= 0 && lastAssistant >= 0) break
  }

  if (lastUser > lastAssistant) {
    let insertAt = lastUser + 1
    while (insertAt < items.length && items[insertAt]?.kind === 'tool') insertAt++
    return insertAt
  }

  if (lastAssistant < 0) return items.length
  let insertAt = lastAssistant + 1
  while (insertAt < items.length && items[insertAt]?.kind === 'tool') insertAt++
  return insertAt
}

function appendTool(
  prev: UiItem[],
  toolItem: Extract<UiItem, { kind: 'tool' }>,
  runStartedAt?: number | null
): UiItem[] {
  const insertAt = toolInsertIndex(prev)
  const before = insertAt > 0 ? prev[insertAt - 1] : undefined
  const prevGroupClosed =
    before?.kind === 'tool' && before.groupTiming?.endedAt != null
  const isNewGroup = !before || before.kind !== 'tool' || prevGroupClosed
  const firstToolInRun = !prev.some((item) => item.kind === 'tool')
  const startedAt =
    isNewGroup && firstToolInRun && runStartedAt != null ? runStartedAt : Date.now()

  const row: Extract<UiItem, { kind: 'tool' }> = isNewGroup
    ? { ...toolItem, groupTiming: { startedAt } }
    : toolItem

  return [...prev.slice(0, insertAt), row, ...prev.slice(insertAt)]
}

function ensureToolRowsForCalls(
  items: UiItem[],
  toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined,
  runStartedAt?: number | null
): UiItem[] {
  if (!toolCalls?.length) return items
  let next = items
  for (const tc of toolCalls) {
    const summary = summarizeToolArgs(tc.name, tc.arguments)
    const existingIdx = findToolRowIndex(next, tc.id, tc.name)
    if (existingIdx >= 0) {
      const existing = next[existingIdx]
    if (existing?.kind === 'tool') {
      if (existing.tool.status !== 'running') continue
      next = next.map((item, i) =>
          i === existingIdx && item.kind === 'tool'
            ? withCanonicalToolId(
                {
                  ...item,
                  tool: {
                    ...item.tool,
                    name: tc.name,
                    summary: summary || item.tool.summary,
                    status: 'running' as const,
                    argsPreview: tc.arguments
                  }
                },
                tc.id
              )
            : item
        )
      }
      continue
    }
    if (next.some((i) => i.kind === 'tool' && (i.id === tc.id || i.tool.id === tc.id))) continue
    next = appendTool(
      next,
      {
        kind: 'tool',
        id: tc.id,
        tool: {
          id: tc.id,
          name: tc.name,
          summary,
          status: 'running',
          argsPreview: tc.arguments
        }
      },
      runStartedAt
    )
  }
  return next
}

/**
 * Drop streaming tool rows that never made it into this step's canonical
 * `toolCalls`. Otherwise a cancelled/malformed edit delta stays `running`
 * forever above later completed work.
 */
function pruneOrphanDeltaToolRows(
  items: UiItem[],
  toolCalls: Array<{ id: string }> | undefined
): UiItem[] {
  const keep = new Set((toolCalls ?? []).map((tc) => tc.id))
  let changed = false
  const next = items.filter((item) => {
    if (item.kind !== 'tool' || item.tool.status !== 'running') return true
    if (keep.has(item.id) || keep.has(item.tool.id)) return true

    const pending = isPendingToolId(item.id) || isPendingToolId(item.tool.id)
    if (pending) {
      changed = true
      return false
    }

    // Real id from a delta that the final assistant_message dropped (including
    // text-only steps where toolCalls is empty/absent).
    changed = true
    return false
  })
  return changed ? next : items
}

/** Close a live trailing tool stretch once every tool in it has finished. */
function closeTrailingGroupIfIdle(items: UiItem[], endedAt = Date.now()): UiItem[] {
  const start = trailingLiveToolGroupStart(items)
  if (start < 0) return items
  for (let i = start; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'tool') break
    if (item.tool.status === 'running') return items
  }
  return closeOpenGroupTimings(items, endedAt)
}

/** Force-fail any tool still marked running (terminal status / interrupted turn). */
function failRunningTools(
  items: UiItem[],
  reason: 'Cancelled' | 'Interrupted' | 'Stopped' | 'Connection lost'
): UiItem[] {
  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'tool' || item.tool.status !== 'running') return item
    changed = true
    return {
      ...item,
      tool: {
        ...item.tool,
        status: 'fail' as const,
        content: item.tool.content ?? reason
      }
    }
  })
  return changed ? next : items
}

function isPendingToolId(id: string): boolean {
  return id.startsWith('pending_')
}

function parsePendingIndex(toolCallId: string): number | null {
  if (!isPendingToolId(toolCallId)) return null
  const n = Number.parseInt(toolCallId.slice('pending_'.length), 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function pendingRunningToolIndices(items: UiItem[]): number[] {
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'tool') continue
    if (!isPendingToolId(item.id)) continue
    if (item.tool.status !== 'running') continue
    out.push(i)
  }
  return out
}

function findToolRowIndex(items: UiItem[], toolCallId: string, toolName?: string): number {
  const direct = items.findIndex(
    (i) => i.kind === 'tool' && (i.id === toolCallId || i.tool.id === toolCallId)
  )
  if (direct >= 0) return direct

  const pendingIndex = parsePendingIndex(toolCallId)
  if (pendingIndex !== null) {
    const pending = pendingRunningToolIndices(items)
    if (pendingIndex < pending.length) return pending[pendingIndex]
    return -1
  }

  const pending = pendingRunningToolIndices(items)
  for (const idx of pending) {
    const item = items[idx]
    if (item.kind !== 'tool') continue
    if (!isPendingToolId(item.tool.id)) continue
    if (toolName && item.tool.name !== 'tool' && item.tool.name !== toolName) continue
    return idx
  }
  return -1
}

/**
 * Adopt the provider's id on both the row and its tool. Leaving `item.id` as the
 * placeholder would keep the row in the pending pool, so a later unmatched result
 * could claim a row that has already been reconciled.
 */
function withCanonicalToolId(
  item: Extract<UiItem, { kind: 'tool' }>,
  toolCallId: string
): Extract<UiItem, { kind: 'tool' }> {
  if (item.id === toolCallId && item.tool.id === toolCallId) return item
  return {
    ...item,
    id: toolCallId,
    tool: { ...item.tool, id: toolCallId }
  }
}

/**
 * Streaming deltas hit one known row per frame. Copying the array and swapping
 * that index keeps every other row's object identity, so memoized rows skip
 * re-rendering, and avoids running a closure over the whole transcript.
 */
function replaceAt(items: UiItem[], index: number, next: UiItem): UiItem[] {
  const copy = items.slice()
  copy[index] = next
  return copy
}

/** Drop pending question prompts, either one answered or all of them. */
function clearQuestions(items: UiItem[], requestId?: string): UiItem[] {
  return items.filter((item) => {
    if (item.kind !== 'question') return true
    if (requestId && item.question.requestId !== requestId) return true
    return false
  })
}

/**
 * `messagesToUiItems` rebuilds chrome without timestamps. After edit/resend,
 * copy `at` / `groupTiming` from the prior UI so earlier turns keep "Worked for…".
 */
function carryTimingFromPriorItems(nextItems: UiItem[], priorItems: UiItem[]): UiItem[] {
  if (priorItems.length === 0) return nextItems
  const priorById = new Map(priorItems.map((item) => [item.id, item]))
  let changed = false
  const out = nextItems.map((item) => {
    const prior = priorById.get(item.id)
    if (!prior || prior.kind !== item.kind) return item
    if (item.kind === 'message' && prior.kind === 'message') {
      if (item.at || !prior.at) return item
      changed = true
      return { ...item, at: prior.at }
    }
    if (item.kind === 'tool' && prior.kind === 'tool') {
      const at = item.at ?? prior.at
      const groupTiming = item.groupTiming ?? prior.groupTiming
      if (at === item.at && groupTiming === item.groupTiming) return item
      changed = true
      return {
        ...item,
        ...(at ? { at } : {}),
        ...(groupTiming ? { groupTiming } : {})
      }
    }
    return item
  })
  return changed ? out : nextItems
}

/** Drop question panels gated on a settled ask_question tool call. */
function clearQuestionsForTool(items: UiItem[], toolCallId: string): UiItem[] {
  return items.filter(
    (item) => !(item.kind === 'question' && item.question.toolCallId === toolCallId)
  )
}

/** Drop pending approval prompts, either one answered or all of them. */
function clearApprovals(items: UiItem[], requestId?: string): UiItem[] {
  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'tool') return item
    let nextItem = item
    if (item.approval && (!requestId || item.approval.requestId === requestId)) {
      changed = true
      const { approval: _approval, ...rest } = item
      nextItem = rest
    }
    return nextItem
  })
  return changed ? next : items
}

/**
 * Settle transcript chrome at end of run: fail live tools, close open group
 * timings, drop pending gates, and clear streaming flags. Shared by the
 * terminal status path and the cancel-recovery fallback.
 */
function finalizeTerminalItems(
  items: UiItem[],
  reason: 'Cancelled' | 'Interrupted' | 'Stopped' | 'Connection lost'
): UiItem[] {
  return clearQuestions(
    clearApprovals(failRunningTools(closeOpenGroupTimings(items), reason))
  ).map((item) => {
    if (item.kind === 'message' && (item.streaming || item.thinkingStreaming)) {
      return { ...item, streaming: false, thinkingStreaming: false }
    }
    return item
  })
}

/** Search from the tail: the row a delta targets is almost always the last one. */
function findMessageIndex(items: UiItem[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'message' && item.id === id) return i
  }
  return -1
}

function runningToolIndices(items: UiItem[]): number[] {
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'tool' && item.tool.status === 'running') out.push(i)
  }
  return out
}

/**
 * Find the row a `tool_result` belongs to. Beyond the id match, a result whose id
 * drifted from its `tool_start` must still land on the live row: appending a second row
 * would leave the original running forever, which is what pins the group on "Exploring".
 * When several same-name tools are running, prefer a unique summary match; otherwise
 * complete the oldest unmatched same-name row (FIFO) so UI status stays in sync with
 * messages instead of leaving tools stuck on "running".
 */
function findToolResultRowIndex(
  items: UiItem[],
  toolCallId: string,
  name: string,
  summary?: string
): number {
  const direct = findToolRowIndex(items, toolCallId, name)
  if (direct >= 0) return direct

  const running = runningToolIndices(items)
  const sameName = running.filter((idx) => {
    const item = items[idx]
    return item.kind === 'tool' && item.tool.name === name
  })
  if (sameName.length === 1) return sameName[0]!
  if (sameName.length > 1 && summary) {
    const bySummary = sameName.filter((idx) => {
      const item = items[idx]
      return item.kind === 'tool' && item.tool.summary === summary
    })
    if (bySummary.length === 1) return bySummary[0]!
    if (bySummary.length > 1) return bySummary[0]!
  }
  // Ambiguous or missing summary: FIFO among same-name running rows.
  if (sameName.length > 0) return sameName[0]!
  if (running.length === 1) return running[0]!
  return -1
}

function errorMessageFromPersisted(events: PersistedEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!isAgentEvent(event)) continue
    if (event.type === 'error') return event.message
  }
  return null
}

function errorCodeFromPersisted(events: PersistedEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!isAgentEvent(event)) continue
    if (event.type === 'error' && event.code) return event.code
  }
  return null
}

function errorFromPersisted(
  events: PersistedEvent[],
  dismissedErrorMessage: string | null = null
): string | null {
  const message = errorMessageFromPersisted(events)
  if (!message) return null
  if (dismissedErrorMessage && dismissedErrorMessage === message) return null
  return message
}

/** A turn that ended before the work was finished, offering a Continue affordance. */
export type IncompleteTurnState = {
  reason: IncompleteReason
  message: string
}

export type WriteCheckpointFileState = {
  path: string
  action: 'created' | 'modified' | 'deleted'
  undoable: boolean
  resolved?: 'kept' | 'discarded'
}

export type WriteCheckpointState = {
  checkpointId: string
  undone: boolean
  files: WriteCheckpointFileState[]
}

function incompleteFromPersisted(events: PersistedEvent[]): IncompleteTurnState | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!isAgentEvent(event)) continue
    if (event.type === 'incomplete') {
      return { reason: event.reason, message: event.message }
    }
  }
  return null
}

function writeCheckpointFromPersisted(events: PersistedEvent[]): WriteCheckpointState | null {
  const unresolved: Extract<AgentEvent, { type: 'writes_checkpoint' }>[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!isAgentEvent(event) || event.type !== 'writes_checkpoint') continue
    const files = event.files.map((f) => ({
      path: f.path,
      action: f.action,
      undoable: f.undoable,
      ...(f.resolved ? { resolved: f.resolved } : {})
    }))
    const fullyResolved =
      files.length > 0 && files.every((f) => Boolean(f.resolved) || !f.undoable)
    if (event.undone === true || fullyResolved) continue
    unresolved.push(event)
  }
  if (unresolved.length === 0) return null

  const latest = unresolved[0]
  const fileMap = new Map<string, WriteCheckpointFileState>()
  for (const checkpoint of [...unresolved].reverse()) {
    for (const f of checkpoint.files) {
      fileMap.set(f.path, {
        path: f.path,
        action: f.action,
        undoable: f.undoable,
        ...(f.resolved ? { resolved: f.resolved } : {})
      })
    }
  }
  const files = [...fileMap.values()]
  const mergedResolved =
    files.length > 0 && files.every((f) => Boolean(f.resolved) || !f.undoable)
  return {
    checkpointId: latest.checkpointId,
    undone: mergedResolved,
    files
  }
}

function modeFromPersisted(events: PersistedEvent[]): AgentInteractionMode | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!isAgentEvent(event)) continue
    if (event.type === 'mode_changed') return event.mode
  }
  return null
}

function hydrateFromDisk(
  kept: ChatMessage[],
  events: PersistedEvent[],
  dismissedErrorMessage: string | null = null
) {
  const items = applyEventTimestamps(
    applyPersistedLiveTools(messagesToUiItems(kept), events),
    events
  ).map((item) => {
    if (item.kind !== 'tool' || item.tool.presentation) return item
    return {
      ...item,
      tool: {
        ...item.tool,
        presentation: toolPresentation(item.tool.name, item.tool.argsPreview, item.tool.summary)
      }
    }
  })
  return {
    messages: kept,
    error: errorFromPersisted(events, dismissedErrorMessage),
    errorCode: errorCodeFromPersisted(events),
    incomplete: incompleteFromPersisted(events),
    contextUsage: summarizeContextUsageFromEvents(events),
    items: appendRunErrorItems(finalizeHydratedTranscript(items, events), events),
    writeCheckpoint: writeCheckpointFromPersisted(events)
  }
}

function appendRunErrorItems(items: UiItem[], events: PersistedEvent[]): UiItem[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const row = events[i]
    const event = row?.event
    if (!isAgentEvent(event)) continue
    if (event.type !== 'error') continue
    const id = `run-error:${row.at}:${i}`
    if (items.some((item) => item.kind === 'run_error' && item.id === id)) return items
    return [
      ...items,
      {
        kind: 'run_error' as const,
        id,
        message: event.message,
        ...(event.code ? { code: event.code } : {}),
        at: row.at
      }
    ]
  }
  return items
}

export type PendingFollowUpState = {
  id: string
  itemId: string
  preview: string
  text: string
  /** Full queued message — preserved so text-only edits keep attachments. */
  message?: ChatMessage
}

function mergeUserFollowUpText(content: MessageContent | undefined, text: string): MessageContent {
  if (content == null || typeof content === 'string') return text
  const parts = [...content]
  const textIdx = parts.findIndex((part) => part.type === 'text')
  if (textIdx >= 0) {
    parts[textIdx] = { type: 'text', text }
  } else {
    parts.unshift({ type: 'text', text })
  }
  return parts
}

export type ChatStreamState = {
  items: UiItem[]
  messages: ChatMessage[]
  running: boolean
  runId: string | null
  error: string | null
  /** Structured code from the last agent `error` event (e.g. PROVIDER_STREAM). */
  errorCode: string | null
  runNotice: string | null
  /** Survives the terminal status event, unlike `runNotice`. */
  incomplete: IncompleteTurnState | null
  /** Live reconnect/backoff state from `network_wait` events. */
  networkWait: {
    attempt: number
    maxAttempts: number
    retryInMs: number
    code?: string
  } | null
  contextUsage: ContextUsageState | null
  runStartedAt: number | null
  runTerminalTick: number
  pendingRun: boolean
  transcriptLoading: boolean
  /** Turn summary disclosure — survives transcript remounts like tool/group expand state. */
  collapsedTurnIndices: number[]
  /** Latest turn write checkpoint for Undo on the Files Changed card. */
  writeCheckpoint: WriteCheckpointState | null
  /** Mid-run follow-ups waiting to be injected into the live agent loop. */
  pendingFollowUps: PendingFollowUpState[]
}

export type ChatStreamController = ChatStreamState & {
  workspacePath: string
  /** Live chatStart invoke id for the active turn (null when idle). */
  getInvokeId: () => number | null
  send: (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ) => Promise<boolean>
  /** Replace a past user message, restore write checkpoints, truncate later turns, re-run. */
  editAndResend: (
    editMessageIndex: number,
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ) => Promise<boolean>
  /** Rewind to a past user message: restore files, truncate later turns, no re-run. */
  revertToUserMessage: (userMessageIndex: number) => Promise<boolean>
  /** Drop a still-queued mid-run follow-up before the loop applies it. */
  removeFollowUp: (id: string) => Promise<boolean>
  /** Update queued follow-up text before the loop applies it. */
  editFollowUp: (id: string, text: string) => Promise<boolean>
  /** Move a queued follow-up to the front of the drain order. */
  sendFollowUpNow: (id: string) => Promise<boolean>
  stop: () => Promise<void>
  reset: () => void
  loadTranscript: (loaded: ChatMessage[], events?: PersistedEvent[]) => void
  /** Load messages without canceling an active/background run (restore / tab select). */
  hydrateTranscript: (loaded: ChatMessage[], events?: PersistedEvent[]) => void
  reattachActiveRun: (runId: string) => Promise<void>
  clearError: () => void
  /** Lazy-load full tool output from disk when IPC preview was truncated. */
  loadToolContent: (toolCallId: string) => Promise<string | null>
  /** Persist thinking block expand/collapse across transcript remounts. */
  setThinkingExpanded: (messageId: string, expanded: boolean) => void
  /** Persist tool detail expand/collapse across transcript remounts. */
  setToolExpanded: (toolCallId: string, expanded: boolean) => void
  /** Persist an activity group's disclosure state, keyed by its first tool row. */
  setGroupExpanded: (anchorToolCallId: string, expanded: boolean) => void
  /** Persist turn summary collapse across transcript remounts. */
  toggleTurnCollapsed: (turnIndex: number) => void
  /** Park a gated tool call on its transcript row until the reader answers. */
  handleApprovalRequest: (request: ToolApprovalRequest) => void
  respondToApproval: (requestId: string, decision: ToolApprovalDecision) => Promise<void>
  handleQuestionRequest: (request: AgentQuestionRequest) => void
  respondToQuestion: (requestId: string, answers: AgentQuestionAnswer[]) => Promise<void>
  /** Reload transcript from disk when a run finished but IPC was missed. */
  syncFromDisk: (runId: string, opts?: { ignoreActiveList?: boolean }) => Promise<boolean>
  /** Update meter + notice after a manual Compact now. */
  applyManualCompaction: (result: {
    estimatedTokens?: number
    contextWindow?: number
    contentWindow?: number
    tokenEstimate: number
  }) => void
  /** Mark the live write checkpoint as undone after a successful IPC undo. */
  markWriteCheckpointUndone: (checkpointId?: string) => void
  /** Apply Keep/Discard results onto the live write checkpoint state. */
  applyWriteCheckpointResolution: (result: {
    checkpointId: string
    kept: string[]
    discarded: string[]
    fullyResolved: boolean
  }) => void
  handleEvent: (event: AgentEvent) => void
  /**
   * When true, high-frequency stream events are ignored (agent still runs in main).
   * Call `resumeUiIfNeeded` when the run becomes visible again.
   */
  setUiSuspended: (suspended: boolean) => void
  /** Clear suspend and rehydrate transcript from disk if stream events were skipped. */
  resumeUiIfNeeded: () => Promise<void>
  readonly uiSuspended: boolean
  subscribe: (listener: () => void) => () => void
  subscribeItems: (listener: () => void) => () => void
  subscribeMeta: (listener: () => void) => () => void
  getRevision: () => number
  getItemsRevision: () => number
  getMetaRevision: () => number
  getContextUsage: () => import('@shared/utils/contextUsage').ContextUsageState | null
  setTranscriptLoading: (loading: boolean) => void
  /** True after `dispose()`; async restores must not hydrate this instance. */
  readonly disposed: boolean
  dispose: () => void
}

/** Events still applied while UI is suspended (approvals/questions use separate handlers). */
const UI_SUSPEND_ALLOWED_EVENTS = new Set<AgentEvent['type']>([
  'status',
  'error',
  'incomplete',
  'network_wait',
  'mode_changed',
  // Live tool chrome — not persisted; dropping loses output with no disk backfill.
  'terminal_output_delta',
  'tool_progress'
])

export type CreateChatStreamControllerOptions = {
  workspacePath: string
  runId?: string | null
  onRunIdAssigned?: (runId: string) => void
  onTerminal?: () => void
  /** Current Ask / Plan / Agent mode for chatStart. */
  getAgentMode?: () => AgentInteractionMode
  /** Sync composer mode when the agent calls switch_mode. */
  onAgentModeChange?: (mode: AgentInteractionMode) => void
}

export function createChatStreamController(
  options: CreateChatStreamControllerOptions
): ChatStreamController {
  const { workspacePath, onRunIdAssigned, onTerminal, getAgentMode, onAgentModeChange } = options
  const listeners = new Set<() => void>()
  const itemsListeners = new Set<() => void>()
  const metaListeners = new Set<() => void>()
  const closedRuns = new Set<string>()
  let assistantId: string | null = null
  /** Row that owns the current step's reasoning, cleared when the step closes. */
  let reasoningId: string | null = null
  /** Next reasoning delta opens a new step, so it needs a break from the previous one. */
  let reasoningSegmentBreak = false
  let runId: string | null = options.runId ?? null
  /** Run id used for lazy tool-result loads after the active session id is cleared. */
  let contentRunId: string | null = options.runId ?? null
  let awaitingRun = false
  let pendingCancel = false
  let ignoreStreamEvents = false
  /** Skip transcript-mutating stream events while the run is not UI-visible. */
  let uiSuspended = false
  /** True after stream events were dropped while suspended — needs disk catch-up. */
  let needsUiCatchUp = false
  /** Bumped on suspend / new resume so in-flight catch-up cannot unsuspend stale work. */
  let uiResumeGeneration = 0
  // A run is reused across turns, so runId alone cannot separate the live turn from a
  // prior one still draining. Events carry the invoke that produced them.
  let activeInvokeId: number | null = null
  const supersededInvokeIds = new Set<number>()
  let disposed = false
  let revision = 0
  let itemsRevision = 0
  let metaRevision = 0
  let turnSeq = 0
  let completedTurnSeq = 0
  let runningTurnSeq = 0
  let lastRunErrorMessage: string | null = null
  let lastRunErrorCode: string | null = null
  /** Persisted error message dismissed by the reader; hydrate skips restoring it. */
  let dismissedErrorMessage: string | null = null
  let usageTotals: StepUsageTotals = emptyStepUsageTotals()
  let streamPatchRaf: number | null = null
  /** Coalesce reasoning deltas — markdown/shiki is skipped but DOM still updates. */
  let thinkingPatchTimer: ReturnType<typeof setTimeout> | null = null
  const THINKING_PATCH_MS = 100
  let pendingTextDelta = ''
  let pendingThinkingDelta = ''
  let pendingToolCallDeltas: Array<{
    toolCallId: string
    name?: string
    argumentsDelta: string
  }> = []
  type PendingTerminalPiece = { text: string; stream: 'stdout' | 'stderr' }
  const pendingTerminalByTool = new Map<string, PendingTerminalPiece[]>()
  type PendingToolProgressEntry = {
    parentToolCallId: string
    kind: UiToolProgressEntry['kind']
    text: string
  }
  let pendingToolProgress: PendingToolProgressEntry[] = []
  const TERMINAL_UI_MAX = 64 * 1024
  const toolContentCache = new Map<string, string>()

  const applyToolCallDelta = (
    items: UiItem[],
    event: { toolCallId: string; name?: string; argumentsDelta: string },
    runStartedAt: number | null
  ): UiItem[] => {
    const existingIdx = findToolRowIndex(items, event.toolCallId, event.name)
    const existing =
      existingIdx >= 0 && items[existingIdx].kind === 'tool' ? items[existingIdx] : undefined
    const toolName = event.name || (existing?.kind === 'tool' ? existing.tool.name : '')
    const argsPreview =
      (existing?.kind === 'tool' ? existing.tool.argsPreview ?? '' : '') + event.argumentsDelta
    const resolvedName = toolName || (existing?.kind === 'tool' ? existing.tool.name : '') || 'tool'
    const summarized = summarizeToolArgs(resolvedName, argsPreview)
    const summary = isUnresolvedToolName(resolvedName)
      ? ''
      : summarized || (existing?.kind === 'tool' ? existing.tool.summary : '') || ''
    if (existing?.kind === 'tool') {
      return replaceAt(
        items,
        existingIdx,
        withCanonicalToolId(
          {
            ...existing,
            tool: withPresentationLock(
              {
                ...existing.tool,
                name: toolName || existing.tool.name,
                argsPreview,
                summary
              },
              toolName || existing.tool.name,
              argsPreview
            )
          },
          event.toolCallId
        )
      )
    }
    return appendTool(
      items,
      {
        kind: 'tool' as const,
        id: event.toolCallId,
        tool: withPresentationLock(
          {
            id: event.toolCallId,
            name: toolName || 'tool',
            summary,
            status: 'running' as const,
            argsPreview: event.argumentsDelta
          },
          toolName || 'tool',
          event.argumentsDelta
        )
      },
      runStartedAt
    )
  }

  /** Close the open reasoning block once answer text or tool calls begin. */
  const closeOpenThinkingStep = (): void => {
    if (!reasoningId) return
    const id = reasoningId
    const index = findMessageIndex(state.items, id)
    if (index < 0) return
    const item = state.items[index]
    if (item?.kind !== 'message' || !item.thinkingStreaming) return
    patch({
      items: replaceAt(state.items, index, {
        ...item,
        thinkingStreaming: false
      })
    })
  }

  const scheduleToolCallDelta = (
    event: Extract<AgentEvent, { type: 'tool_call_delta' }>
  ): void => {
    if (isToolShapedTextLeak(pendingTextDelta)) {
      pendingTextDelta = ''
    }
    const last = pendingToolCallDeltas[pendingToolCallDeltas.length - 1]
    if (last && last.toolCallId === event.toolCallId) {
      last.argumentsDelta += event.argumentsDelta
      if (event.name) last.name = event.name
    } else {
      pendingToolCallDeltas.push({
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsDelta: event.argumentsDelta
      })
    }
    scheduleStreamingPatch()
  }

  const materializePendingToolCallDeltas = (): void => {
    if (!pendingToolCallDeltas.length) return
    let items = state.items
    const deltas = pendingToolCallDeltas
    pendingToolCallDeltas = []
    for (const delta of deltas) {
      items = applyToolCallDelta(items, delta, state.runStartedAt)
    }
    patch({ items: scrubStreamingAssistantToolLeak(items) })
  }

  const applyStreamingPatches = (): void => {
    let items = state.items
    let changed = false

    if (pendingThinkingDelta && reasoningId) {
      const text = pendingThinkingDelta
      pendingThinkingDelta = ''
      const id = reasoningId
      const index = findMessageIndex(items, id)
      if (index < 0) {
        // `thinkingExpanded` stays unset: it records the reader's own choice, and
        // leaving it blank lets the block follow the stream on its own.
        items = insertAssistantItem(items, {
          kind: 'message',
          id,
          role: 'assistant',
          content: '',
          thinking: text,
          thinkingStreaming: true,
          streaming: false
        })
      } else {
        const current = items[index] as Extract<UiItem, { kind: 'message' }>
        const prior = current.thinking ?? ''
        items = replaceAt(items, index, {
          ...current,
          thinking:
            reasoningSegmentBreak && prior.trim() ? `${prior.trimEnd()}\n\n${text}` : prior + text,
          thinkingStreaming: true
        })
      }
      reasoningSegmentBreak = false
      changed = true
    } else {
      pendingThinkingDelta = ''
    }

    if (pendingTextDelta && assistantId) {
      const text = pendingTextDelta
      pendingTextDelta = ''
      const id = assistantId
      const index = findMessageIndex(items, id)
      if (index < 0) {
        items = insertAssistantItem(items, {
          kind: 'message',
          id,
          role: 'assistant',
          content: stripToolShapedAssistantTextForStream(text),
          streaming: true
        })
      } else {
        const current = items[index] as Extract<UiItem, { kind: 'message' }>
        items = replaceAt(items, index, {
          ...current,
          content: stripToolShapedAssistantTextForStream(current.content + text),
          streaming: true
        })
      }
      changed = true
    } else {
      pendingTextDelta = ''
    }

    if (pendingToolCallDeltas.length) {
      if (reasoningId) {
        const id = reasoningId
        const index = findMessageIndex(items, id)
        if (index >= 0) {
          const item = items[index]
          if (item?.kind === 'message' && item.thinkingStreaming) {
            items = replaceAt(items, index, {
              ...item,
              thinkingStreaming: false
            })
          }
        }
      }
      const deltas = pendingToolCallDeltas
      pendingToolCallDeltas = []
      for (const delta of deltas) {
        items = applyToolCallDelta(items, delta, state.runStartedAt)
      }
      changed = true
    }

    if (pendingTerminalByTool.size) {
      for (const [toolCallId, pieces] of pendingTerminalByTool) {
        const idx = findToolRowIndex(items, toolCallId, 'terminal')
        const item = idx >= 0 ? items[idx] : undefined
        if (!item || item.kind !== 'tool' || item.tool.status !== 'running') continue
        let prev = item.tool.content ?? ''
        if (prev.length >= TERMINAL_UI_MAX) continue
        for (const piece of pieces) {
          if (prev.length >= TERMINAL_UI_MAX) break
          const room = TERMINAL_UI_MAX - prev.length
          let text = sanitizeTerminalDisplayText(piece.text)
          if (piece.stream === 'stderr' && !prev.includes('stderr:\n')) {
            text = `${prev ? '\n' : ''}stderr:\n${piece.text}`
          }
          const clipped = text.length > room ? text.slice(0, room) : text
          if (!clipped) continue
          prev += clipped
        }
        if (prev !== (item.tool.content ?? '')) {
          items = replaceAt(items, idx, {
            ...item,
            tool: { ...item.tool, content: prev }
          })
          changed = true
        }
      }
      pendingTerminalByTool.clear()
    }

    if (pendingToolProgress.length) {
      const entries = pendingToolProgress
      pendingToolProgress = []
      for (const event of entries) {
        const idx = findToolRowIndex(items, event.parentToolCallId)
        const item = idx >= 0 ? items[idx] : undefined
        if (!item || item.kind !== 'tool') continue
        const progress = [...(item.toolProgress ?? []), { kind: event.kind, text: event.text }].slice(
          -MAX_TOOL_PROGRESS_ENTRIES
        )
        items = replaceAt(items, idx, { ...item, toolProgress: progress })
        changed = true
      }
    }

    if (changed) {
      items = scrubStreamingAssistantToolLeak(items)
      patch({ items })
    }
  }

  const flushThinkingPatchTimer = (): void => {
    if (thinkingPatchTimer != null) {
      clearTimeout(thinkingPatchTimer)
      thinkingPatchTimer = null
    }
  }

  const flushStreamingPatches = (): void => {
    flushThinkingPatchTimer()
    if (streamPatchRaf != null) {
      cancelAnimationFrame(streamPatchRaf)
      streamPatchRaf = null
    }
    applyStreamingPatches()
  }

  const scheduleStreamingPatch = (): void => {
    if (streamPatchRaf != null) return
    streamPatchRaf = requestAnimationFrame(() => {
      streamPatchRaf = null
      applyStreamingPatches()
    })
  }

  const scheduleTextDelta = (text: string): void => {
    flushThinkingPatchTimer()
    pendingTextDelta += text
    scheduleStreamingPatch()
  }

  const scheduleThinkingDelta = (text: string): void => {
    pendingThinkingDelta += text
    if (thinkingPatchTimer != null) return
    thinkingPatchTimer = setTimeout(() => {
      thinkingPatchTimer = null
      scheduleStreamingPatch()
    }, THINKING_PATCH_MS)
  }

  const state: ChatStreamState = {
    items: [],
    messages: [],
    running: false,
    runId,
    error: null,
    errorCode: null,
    runNotice: null,
    incomplete: null,
    networkWait: null,
    contextUsage: null,
    runStartedAt: null,
    runTerminalTick: 0,
    pendingRun: false,
    transcriptLoading: false,
    collapsedTurnIndices: [],
    writeCheckpoint: null,
    pendingFollowUps: []
  }

  const notify = (): void => {
    if (disposed) return
    revision += 1
    for (const listener of listeners) listener()
  }

  const notifyItems = (): void => {
    if (disposed) return
    itemsRevision += 1
    for (const listener of itemsListeners) listener()
    notify()
  }

  const notifyMeta = (): void => {
    if (disposed) return
    metaRevision += 1
    for (const listener of metaListeners) listener()
    notify()
  }

  const getRevision = (): number => revision
  const getItemsRevision = (): number => itemsRevision
  const getMetaRevision = (): number => metaRevision
  const getContextUsage = (): typeof state.contextUsage => state.contextUsage

  const patch = (partial: Partial<ChatStreamState>): void => {
    if (disposed) return
    const touchedItems = Object.prototype.hasOwnProperty.call(partial, 'items')
    const touchedMeta = Object.keys(partial).some((key) => key !== 'items')
    Object.assign(state, partial)
    if (touchedItems && touchedMeta) {
      itemsRevision += 1
      metaRevision += 1
      for (const listener of itemsListeners) listener()
      for (const listener of metaListeners) listener()
      notify()
      return
    }
    if (touchedItems) {
      notifyItems()
      return
    }
    if (touchedMeta) notifyMeta()
  }

  const closeRun = (id: string | null | undefined): void => {
    if (!id) return
    closedRuns.add(id)
  }

  const clearSessionUi = (opts?: { preservePendingCancel?: boolean }): void => {
    assistantId = null
    reasoningId = null
    runId = null
    contentRunId = null
    ignoreStreamEvents = false
    dismissedErrorMessage = null
    lastRunErrorMessage = null
    lastRunErrorCode = null
    if (activeInvokeId != null) supersededInvokeIds.add(activeInvokeId)
    activeInvokeId = null
    usageTotals = emptyStepUsageTotals()
    toolContentCache.clear()
    if (!opts?.preservePendingCancel) pendingCancel = false
    patch({
      items: [],
      messages: [],
      error: null,
      errorCode: null,
      runNotice: null,
      incomplete: null,
      networkWait: null,
      contextUsage: null,
      runId: null,
      running: false,
      runStartedAt: null,
      pendingRun: false,
      collapsedTurnIndices: [],
      writeCheckpoint: null,
      pendingFollowUps: []
    })
  }

  const assignRunId = (id: string): void => {
    if (closedRuns.has(id)) return
    const changed = runId !== id
    runId = id
    contentRunId = id
    patch({ runId: id, pendingRun: false })
    if (changed) onRunIdAssigned?.(id)
  }

  /** True for events left over from a turn that a newer send has already replaced. */
  const isSupersededEvent = (event: AgentEvent): boolean => {
    if (event.invokeId == null) return false
    if (supersededInvokeIds.has(event.invokeId)) return true
    return activeInvokeId != null && event.invokeId !== activeInvokeId
  }

  const discardPendingStreamPatches = (): void => {
    pendingTextDelta = ''
    pendingThinkingDelta = ''
    pendingToolCallDeltas = []
    pendingTerminalByTool.clear()
    pendingToolProgress = []
    flushThinkingPatchTimer()
    if (streamPatchRaf != null) {
      cancelAnimationFrame(streamPatchRaf)
      streamPatchRaf = null
    }
  }

  const setUiSuspended = (suspended: boolean): void => {
    if (disposed) return
    if (suspended === uiSuspended) return
    if (suspended) {
      discardPendingStreamPatches()
      uiSuspended = true
      // Invalidate any in-flight resume so catch-up cannot clear a later suspend.
      uiResumeGeneration += 1
      // needsUiCatchUp is set only when stream events are skipped while suspended.
    } else {
      uiSuspended = false
    }
  }

  /** Force-reload transcript while preserving live running state (after UI suspend). */
  const catchUpUiFromDisk = async (id: string): Promise<boolean> => {
    if (closedRuns.has(id) || disposed) return false
    let liveInvokeId: number | null = null
    let stillActive = false
    let pendingFromMain: { id: string; preview: string }[] = []
    if (window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (closedRuns.has(id) || disposed) return false
      if (active.ok) {
        const live = active.data.find((entry) => entry.runId === id)
        stillActive = Boolean(live)
        liveInvokeId = live?.invokeId ?? null
        pendingFromMain = live?.pendingFollowUps ?? []
      }
    } else {
      stillActive = state.running || state.pendingRun
    }
    if (!window.vyotiq?.loadRun) return false
    const res = await window.vyotiq.loadRun(workspacePath, id)
    if (closedRuns.has(id) || disposed) return false
    if (!res.ok) {
      logger.warn('catchUpUiFromDisk loadRun failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      return false
    }
    let events: PersistedEvent[] = []
    let eventsLoadError: string | null = null
    if (window.vyotiq.loadRunEvents) {
      const eventsRes = await window.vyotiq.loadRunEvents(workspacePath, id)
      if (closedRuns.has(id) || disposed) return false
      if (eventsRes.ok) events = eventsRes.data
      else eventsLoadError = eventsRes.error
    }
    const kept = messagesForNextTurn(res.data.messages)
    assistantId = null
    reasoningId = null
    runId = id
    contentRunId = id
    if (liveInvokeId != null) activeInvokeId = liveInvokeId
    const mode = modeFromPersisted(events)
    if (mode) onAgentModeChange?.(mode)
    const hydratedPending: PendingFollowUpState[] =
      pendingFromMain.length > 0
        ? pendingFromMain.map((entry) => {
            const local = state.pendingFollowUps.find((p) => p.id === entry.id)
            return {
              id: entry.id,
              itemId: local?.itemId ?? `followup-${entry.id}`,
              preview: local?.preview ?? entry.preview,
              text: local?.text ?? entry.preview,
              ...(local?.message ? { message: local.message } : {})
            }
          })
        : state.pendingFollowUps
    patch({
      ...hydrateFromDisk(kept, events, dismissedErrorMessage),
      pendingFollowUps: hydratedPending,
      runId: id,
      pendingRun: false,
      running: stillActive,
      runStartedAt: stillActive ? state.runStartedAt ?? Date.now() : null,
      ...(eventsLoadError ? { error: eventsLoadError } : {})
    })
    if (!stillActive) onTerminal?.()
    return true
  }

  const resumeUiIfNeeded = async (): Promise<void> => {
    if (disposed) return
    const hadCatchUp = needsUiCatchUp
    if (!hadCatchUp) {
      setUiSuspended(false)
      recordUiResume(false)
      return
    }
    // Stay suspended until disk catch-up finishes so live events cannot apply
    // and then be clobbered by a stale hydrateFromDisk patch. One pass only:
    // a live stream during await would otherwise loop forever.
    const gen = ++uiResumeGeneration
    recordUiResume(true)
    needsUiCatchUp = false
    const id = runId ?? contentRunId
    const ok = id ? await catchUpUiFromDisk(id) : true
    if (disposed || gen !== uiResumeGeneration) return
    if (!ok) {
      needsUiCatchUp = true
      return
    }
    // Deltas skipped during catch-up are not on this disk snapshot; clear the
    // flag so we unsuspend and continue from the live stream afterward.
    needsUiCatchUp = false
    setUiSuspended(false)
  }

  const handleEvent = (event: AgentEvent): void => {
    if (disposed) return
    if (closedRuns.has(event.runId)) return
    if (isSupersededEvent(event)) return

    if (runId) {
      if (event.runId !== runId) return
    } else if (awaitingRun) {
      assignRunId(event.runId)
    } else {
      return
    }

    if (
      ignoreStreamEvents &&
      event.type !== 'follow_up_applied' &&
      event.type !== 'follow_up_dropped'
    ) {
      return
    }

    if (uiSuspended && !UI_SUSPEND_ALLOWED_EVENTS.has(event.type)) {
      needsUiCatchUp = true
      recordUiSuspendSkip()
      return
    }

    if (
      event.type !== 'text_delta' &&
      event.type !== 'thinking_delta' &&
      event.type !== 'tool_call_delta'
    ) {
      // Scrub before flush so leak text never paints one frame ahead of tool chrome
      // (also covers status/usage events that flush pending text).
      if (isToolShapedTextLeak(pendingTextDelta)) {
        pendingTextDelta = ''
      } else if (pendingTextDelta) {
        pendingTextDelta = stripToolShapedAssistantTextForStream(pendingTextDelta)
      }
      flushStreamingPatches()
      const scrubbed = scrubStreamingAssistantToolLeak(state.items)
      if (scrubbed !== state.items) {
        patch({ items: scrubbed })
      }
    }

    if (event.type === 'text_delta') {
      if (!assistantId) assistantId = messageUiId('assistant', state.messages.length)
      materializePendingToolCallDeltas()
      closeOpenThinkingStep()
      scheduleTextDelta(event.text)
      return
    } else if (event.type === 'thinking_delta') {
      if (!assistantId) assistantId = messageUiId('assistant', state.messages.length)
      if (!reasoningId) reasoningId = assistantId
      scheduleThinkingDelta(event.text)
      return
    } else if (event.type === 'thinking_done') {
      flushStreamingPatches()
      reasoningSegmentBreak = true
      const id = reasoningId
      if (!id) return
      const doneAt = new Date().toISOString()
      patch({
        items: state.items.map((item) =>
          item.kind === 'message' && item.id === id
            ? {
                ...item,
                thinking: event.text ? mergeThinking(item.thinking, event.text) : item.thinking,
                thinkingStreaming: false,
                at: item.at ?? doneAt
              }
            : item
        )
      })
      return
    } else if (event.type === 'assistant_message') {
      const id = assistantId ?? messageUiId('assistant', state.messages.length)
      assistantId = null
      reasoningSegmentBreak = true
      const messageAt = new Date().toISOString()
      const content = stripToolShapedAssistantText(event.content)
      // Keep same-turn tool stretches live when this message still has toolCalls.
      // Only close when this is a text-only follow-up (next iteration / final answer).
      const base = event.toolCalls?.length
        ? state.items
        : closeOpenGroupTimings(state.items)
      const exists = base.some((i) => i.kind === 'message' && i.id === id)
      const reasoningTarget =
        event.thinking && reasoningId && reasoningId !== id ? reasoningId : null
      let nextItems = reasoningTarget
        ? base.map((item) =>
            item.kind === 'message' && item.id === reasoningTarget
              ? {
                  ...item,
                  thinking: mergeThinking(item.thinking, event.thinking ?? ''),
                  thinkingStreaming: false
                }
              : item
          )
        : base
      if (exists) {
        nextItems = nextItems.map((item) =>
          item.kind === 'message' && item.id === id
            ? {
                ...item,
                content: content || stripToolShapedAssistantText(item.content),
                thinking: reasoningTarget
                  ? item.thinking
                  : mergeThinking(item.thinking, event.thinking ?? ''),
                thinkingStreaming: false,
                streaming: false,
                at: item.at ?? messageAt
              }
            : item
        )
      } else if (content || (event.thinking && !reasoningTarget)) {
        nextItems = insertAssistantItem(nextItems, {
          kind: 'message',
          id,
          role: 'assistant',
          content,
          thinking: event.thinking,
          thinkingStreaming: false,
          streaming: false,
          at: messageAt
        })
      }
      reasoningId = null
      const nextMessages = appendAssistantWithTools(
        state.messages,
        content,
        event.toolCalls,
        event.thinking
      )
      nextItems = ensureToolRowsForCalls(nextItems, event.toolCalls, state.runStartedAt)
      nextItems = pruneOrphanDeltaToolRows(nextItems, event.toolCalls)
      patch({ items: nextItems, messages: nextMessages })
    } else if (event.type === 'tool_call_delta') {
      scheduleToolCallDelta(event)
      return
    } else if (event.type === 'tool_start') {
      assistantId = null
      const items = state.items
      const toolAt = new Date().toISOString()
      const existingIdx = findToolRowIndex(items, event.toolCallId, event.name)
      const existing =
        existingIdx >= 0 && items[existingIdx].kind === 'tool' ? items[existingIdx] : undefined
      if (existing?.kind === 'tool') {
        patch({
          items: replaceAt(
            items,
            existingIdx,
            withCanonicalToolId(
              {
                ...existing,
                at: existing.at ?? toolAt,
                toolExpanded: existing.toolExpanded,
                tool: withPresentationLock(
                  {
                    ...existing.tool,
                    name: event.name,
                    summary: event.summary,
                    status: 'running' as const
                  },
                  event.name,
                  existing.tool.argsPreview
                )
              },
              event.toolCallId
            )
          )
        })
      } else {
        patch({
          items: appendTool(
            items,
            {
              kind: 'tool' as const,
              id: event.toolCallId,
              at: toolAt,
              toolExpanded: undefined,
              tool: withPresentationLock(
                {
                  id: event.toolCallId,
                  name: event.name,
                  summary: event.summary,
                  status: 'running' as const
                },
                event.name
              )
            },
            state.runStartedAt
          )
        })
      }
    } else if (event.type === 'tool_result') {
      const items = state.items
      const existingIdx = findToolResultRowIndex(
        items,
        event.toolCallId,
        event.name,
        event.summary
      )
      const existing =
        existingIdx >= 0 && items[existingIdx].kind === 'tool' ? items[existingIdx] : undefined
      let nextItems = items
      if (existing?.kind === 'tool') {
        nextItems = replaceAt(
          items,
          existingIdx,
          withCanonicalToolId(
            {
              ...existing,
              // The call is settled, so any prompt it was waiting on is moot.
              approval: undefined,
              // Drop auto-expand so finished bodies collapse; user toggle still wins.
              toolExpanded: existing.toolExpanded === false ? false : undefined,
              tool: {
                ...existing.tool,
                name: event.name,
                summary: event.summary,
                status: event.ok ? 'done' : 'fail',
                content: event.content ?? existing.tool.content,
                contentTruncated: event.contentTruncated ?? existing.tool.contentTruncated
              }
            },
            event.toolCallId
          )
        )
      } else if (existingIdx < 0) {
        // findToolResultRowIndex should have matched any same-name running row
        // (summary, then FIFO). If it still missed, complete the oldest same-name
        // runner instead of appending a second row that leaves the original spinning.
        const runningSame = runningToolIndices(items).filter((idx) => {
          const item = items[idx]
          return item.kind === 'tool' && item.tool.name === event.name
        })
        if (runningSame.length > 0) {
          const idx = runningSame[0]!
          const row = items[idx]
          if (row?.kind === 'tool') {
            nextItems = replaceAt(
              items,
              idx,
              withCanonicalToolId(
                {
                  ...row,
                  approval: undefined,
                  toolExpanded: row.toolExpanded === false ? false : undefined,
                  tool: {
                    ...row.tool,
                    name: event.name,
                    summary: event.summary,
                    status: event.ok ? 'done' : 'fail',
                    content: event.content ?? row.tool.content,
                    contentTruncated: event.contentTruncated ?? row.tool.contentTruncated
                  }
                },
                event.toolCallId
              )
            )
          }
        } else {
          // No live same-name row to complete — create one (hydrate / late result).
          nextItems = appendTool(
            items,
            {
              kind: 'tool' as const,
              id: event.toolCallId,
              tool: {
                id: event.toolCallId,
                name: event.name,
                summary: event.summary,
                status: event.ok ? 'done' : 'fail',
                content: event.content,
                contentTruncated: event.contentTruncated
              }
            },
            state.runStartedAt
          )
        }
      }
      const nextMessages = appendToolResult(
        state.messages,
        event.toolCallId,
        event.name,
        event.content ?? event.summary,
        event.ok
      )
      // ask_question UI is a separate item; clear it when the tool settles
      // (answer, interrupt, timeout) so a stale panel cannot outlive the wait.
      const itemsForPatch =
        event.name === 'ask_question'
          ? clearQuestionsForTool(nextItems, event.toolCallId)
          : nextItems
      patch({
        items: closeTrailingGroupIfIdle(itemsForPatch),
        messages: nextMessages
      })
    } else if (event.type === 'terminal_output_delta') {
      const idx = findToolRowIndex(state.items, event.toolCallId, 'terminal')
      const item = idx >= 0 ? state.items[idx] : undefined
      if (!item || item.kind !== 'tool' || item.tool.status !== 'running') return
      const prev = item.tool.content ?? ''
      if (prev.length >= TERMINAL_UI_MAX) return
      const pending = pendingTerminalByTool.get(event.toolCallId) ?? []
      pending.push({ text: event.text, stream: event.stream ?? 'stdout' })
      pendingTerminalByTool.set(event.toolCallId, pending)
      scheduleStreamingPatch()
    } else if (event.type === 'tool_progress') {
      const idx = findToolRowIndex(state.items, event.parentToolCallId)
      const item = idx >= 0 ? state.items[idx] : undefined
      if (!item || item.kind !== 'tool') return
      pendingToolProgress.push({
        parentToolCallId: event.parentToolCallId,
        kind: event.kind,
        text: event.text
      })
      scheduleStreamingPatch()
    } else if (event.type === 'mode_changed') {
      onAgentModeChange?.(event.mode)
    } else if (event.type === 'error') {
      lastRunErrorMessage = event.message
      lastRunErrorCode = event.code ?? null
      dismissedErrorMessage = null
      // Put detail in the log line — AppError sanitize strips message from `err`.
      logger.warn(`Agent run error: ${event.message}`, {
        scope: 'chat',
        correlationId: event.runId,
        code: agentErrorCode(event),
        err: event.message
      })
      patch({
        error: event.message,
        errorCode: event.code ?? null
      })
    } else if (event.type === 'network_wait') {
      const reconnectIds = new Set([assistantId, reasoningId].filter((id): id is string => !!id))
      patch({
        networkWait: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          retryInMs: event.retryInMs,
          ...(event.code ? { code: event.code } : {})
        },
        items: state.items.map((item) =>
          item.kind === 'message' && reconnectIds.has(item.id)
            ? { ...item, reconnecting: true, streaming: false, thinkingStreaming: false }
            : item
        )
      })
    } else if (event.type === 'stream_reset') {
      // Step retry re-streams from scratch — drop partial text/thinking per IPC contract.
      pendingTextDelta = ''
      pendingThinkingDelta = ''
      pendingToolCallDeltas = []
      flushStreamingPatches()
      const reconnectIds = new Set([assistantId, reasoningId].filter((id): id is string => !!id))
      const nextItems = state.items
        .filter(
          (item) =>
            !(item.kind === 'tool' && item.tool.status === 'running' && !item.approval)
        )
        .map((item) =>
          item.kind === 'message' && reconnectIds.has(item.id)
            ? {
                ...item,
                content: '',
                thinking: undefined,
                reconnecting: true,
                streaming: false,
                thinkingStreaming: false
              }
            : item
        )
      patch({ items: nextItems, networkWait: null })
    } else if (event.type === 'incomplete') {
      patch({
        incomplete: { reason: event.reason, message: event.message }
      })
    } else if (event.type === 'compaction') {
      patch({
        runNotice: 'Context summarized to stay within the model window.'
      })
    } else if (event.type === 'mcp_tools_omitted') {
      const n =
        event.omittedCount === 1 ? '1 MCP tool was' : `${event.omittedCount} MCP tools were`
      patch({
        runNotice: `${n} deferred to fit the context budget — the agent can pin tools with request_mcp_tools, or disable unused MCP servers in Settings → Marketplace.`
      })
    } else if (event.type === 'writes_checkpoint') {
      const files = event.files.map((f) => ({
        path: f.path,
        action: f.action,
        undoable: f.undoable,
        ...(f.resolved ? { resolved: f.resolved } : {})
      }))
      const fullyResolved =
        files.length > 0 && files.every((f) => Boolean(f.resolved) || !f.undoable)
      patch({
        writeCheckpoint: {
          checkpointId: event.checkpointId,
          undone: event.undone === true || fullyResolved,
          files
        }
      })
    } else if (event.type === 'follow_up_queued') {
      // Local send already tracked the entry; ignore duplicates from IPC echo.
      if (state.pendingFollowUps.some((entry) => entry.id === event.id)) return
      patch({
        pendingFollowUps: [
          ...state.pendingFollowUps,
          {
            id: event.id,
            itemId: `followup-${event.id}`,
            preview: event.preview?.trim() || `Follow-up #${event.position}`,
            text: event.preview?.trim() || `Follow-up #${event.position}`
          }
        ]
      })
    } else if (event.type === 'follow_up_applied') {
      const applied = new Set(event.ids)
      const nextPending = state.pendingFollowUps.filter((entry) => !applied.has(entry.id))
      let nextMessages = state.messages
      let nextItems = state.items
      if (event.messages?.length) {
        const existingTail = state.messages.slice(-event.messages.length)
        const alreadyPresent =
          existingTail.length === event.messages.length &&
          existingTail.every((msg, i) => {
            const incoming = event.messages[i]
            return (
              msg.role === incoming?.role &&
              contentDisplayText(msg.content) === contentDisplayText(incoming.content)
            )
          })
        if (!alreadyPresent) {
          nextMessages = messagesForNextTurn([...state.messages, ...event.messages])
          const startIdx = nextMessages.length - event.messages.length
          const newItems = event.messages.map((msg, i) => {
            const followUpId = event.ids[i]
            const pendingEntry = state.pendingFollowUps.find((entry) => entry.id === followUpId)
            const content = msg.content
            const displayText = contentDisplayText(content)
            const imageUrls = contentImages(content)
            const attachments = uiAttachments(content)
            return {
              kind: 'message' as const,
              id: pendingEntry?.itemId ?? messageUiId('user', startIdx + i),
              role: 'user' as const,
              content: displayText,
              images: imageUrls.length ? imageUrls : undefined,
              attachments: attachments.length ? attachments : undefined,
              at: new Date().toISOString()
            }
          })
          nextItems = prependClosed(state.items, newItems)
        }
      }
      patch({
        pendingFollowUps: nextPending,
        ...(nextMessages !== state.messages ? { messages: nextMessages, items: nextItems } : {})
      })
    } else if (event.type === 'follow_up_dropped') {
      const dropped = new Set(event.ids)
      const unappliedItemIds = new Set(
        state.pendingFollowUps.filter((entry) => dropped.has(entry.id)).map((entry) => entry.itemId)
      )
      const droppedCount = state.pendingFollowUps.filter((entry) => dropped.has(entry.id)).length
      const dropNotice =
        droppedCount === 1
          ? 'Queued follow-up was dropped because the run ended.'
          : droppedCount > 1
            ? `${droppedCount} queued follow-ups were dropped because the run ended.`
            : null
      patch({
        pendingFollowUps: state.pendingFollowUps.filter((entry) => !dropped.has(entry.id)),
        ...(dropNotice ? { runNotice: dropNotice } : {}),
        ...(unappliedItemIds.size > 0
          ? { items: state.items.filter((item) => !unappliedItemIds.has(item.id)) }
          : {})
      })
    } else if (event.type === 'step_usage') {
      const usage = stepUsageFromEvent(event)
      if (usage) {
        usageTotals = mergeStepUsageTotals(usageTotals, usage)
        if (state.contextUsage) {
          patch({
            contextUsage: {
              ...state.contextUsage,
              stepUsage: usageTotals,
              updatedAt: new Date().toISOString()
            }
          })
        } else {
          // Seed a minimal meter so early step_usage is not discarded before context_usage.
          patch({
            contextUsage: {
              step: event.step,
              used: 0,
              estimatedTokens: 0,
              window: 0,
              contentWindow: 0,
              compactionTrigger: 0,
              source: 'estimate',
              layers: { system: 0, history: 0, tools: 0, buffer: 0 },
              stepUsage: usageTotals,
              updatedAt: new Date().toISOString()
            }
          })
        }
      }
    } else if (event.type === 'context_usage') {
      const ctx = contextUsageFromEvent(event, usageTotals, state.contextUsage?.layers)
      if (ctx) patch({ contextUsage: ctx })
    } else if (event.type === 'status') {
      if (event.status === 'running') {
        runningTurnSeq = turnSeq
        patch({
          running: true,
          pendingRun: false,
          // Auto-continue after truncation clears the Continue banner for the next step.
          incomplete: null,
          networkWait: null,
          runStartedAt: state.runStartedAt ?? Date.now(),
          items: state.items.map((item) =>
            item.kind === 'message' && item.reconnecting
              ? { ...item, reconnecting: false }
              : item
          )
        })
      }
      if (event.status === 'done' || event.status === 'cancelled' || event.status === 'error') {
        // When the event carries an invoke we started, attribution is exact and any
        // stale terminal was already dropped. Otherwise — a reattached run, or a
        // replay with no stamp — fall back to the turn sequence.
        const attributed = event.invokeId != null && event.invokeId === activeInvokeId
        if (attributed) {
          // Duplicate terminal for the same invoke (e.g. error + status:error) — finalize once.
          if (ignoreStreamEvents && completedTurnSeq >= turnSeq) return
        } else {
          if (turnSeq > 0 && completedTurnSeq >= turnSeq) return
          if (
            completedTurnSeq > 0 &&
            turnSeq > completedTurnSeq &&
            state.running &&
            turnSeq > runningTurnSeq
          ) {
            return
          }
        }

        awaitingRun = false
        pendingCancel = false
        assistantId = null
        reasoningId = null
        ignoreStreamEvents = true
        completedTurnSeq = turnSeq
        const sessionRunId = runId ?? event.runId
        runId = sessionRunId
        const dropUnapplied = event.status !== 'done'
        const unappliedItemIds = dropUnapplied
          ? new Set(state.pendingFollowUps.map((entry) => entry.itemId))
          : null
        if (event.status === 'error' && !state.error) {
          dismissedErrorMessage = null
        }
        const toolStubReason =
          event.status === 'cancelled'
            ? 'Cancelled'
            : event.status === 'error'
              ? state.incomplete?.reason === 'network_interrupted'
                ? 'Connection lost'
                : 'Interrupted'
              : 'Stopped'
        const finalizedItems = finalizeTerminalItems(
          unappliedItemIds && unappliedItemIds.size > 0
            ? state.items.filter((item) => !unappliedItemIds.has(item.id))
            : state.items,
          toolStubReason
        ).map((item) =>
          item.kind === 'message' && item.reconnecting ? { ...item, reconnecting: false } : item
        )
        const errorMessage =
          event.status === 'error' && !state.error
            ? lastRunErrorMessage ?? 'Run failed'
            : state.error
        const withRunError =
          event.status === 'error' && errorMessage
            ? [
                ...finalizedItems,
                {
                  kind: 'run_error' as const,
                  id: `run-error:live:${state.runTerminalTick + 1}`,
                  message: errorMessage,
                  ...(lastRunErrorCode ? { code: lastRunErrorCode } : {})
                }
              ]
            : finalizedItems
        patch({
          pendingRun: false,
          running: false,
          runId: sessionRunId,
          runStartedAt: null,
          pendingFollowUps: event.status === 'done' ? state.pendingFollowUps : [],
          networkWait: null,
          // Keep compaction / MCP budget notices readable after the run ends; cleared on next send.
          runNotice:
            state.runNotice?.startsWith('Context summarized') === true ||
            state.runNotice?.includes('deferred to fit the context budget') === true
              ? state.runNotice
              : null,
          runTerminalTick: state.runTerminalTick + 1,
          ...(event.status === 'error' && !state.error
            ? { error: errorMessage, errorCode: lastRunErrorCode }
            : {}),
          items: withRunError
        })
        onTerminal?.()
      }
    }
  }

  const send = async (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ): Promise<boolean> => {
    const trimmed = text.trim()
    const hasExtras = Boolean(extras?.audio?.length || extras?.nativeFiles?.length)
    if ((!trimmed && !images?.length && !files?.length && !hasExtras) || state.transcriptLoading)
      return false
    if (state.running) {
      return followUp(text, images, files, extras)
    }
    if (!workspacePath) {
      patch({ error: 'Pick a workspace before starting a chat.' })
      return false
    }
    patch({ error: null, errorCode: null, runNotice: null, incomplete: null, networkWait: null })
    lastRunErrorMessage = null
    lastRunErrorCode = null
    usageTotals = emptyStepUsageTotals()
    // Keep last contextUsage so the meter does not flicker away between turns;
    // stepUsage resets via usageTotals and is overwritten on the next event.
    pendingCancel = false
    ignoreStreamEvents = false
    // Anything still arriving from the turn we are replacing is now stale, including a
    // terminal status that would otherwise close out this new turn.
    if (activeInvokeId != null) supersededInvokeIds.add(activeInvokeId)
    activeInvokeId = null
    turnSeq += 1
    const content = buildUserContent(text, images, files, extras)
    const user: ChatMessage = { role: 'user', content }
    const priorMessages = state.messages
    const nextMessages = messagesForNextTurn([...priorMessages, user])
    const userItemId = messageUiId('user', nextMessages.length - 1)
    const imageUrls = contentImages(content)
    const attachments = uiAttachments(content)
    const displayText = contentDisplayText(content)
    const sentAt = new Date().toISOString()
    patch({
      messages: nextMessages,
      items: prependClosed(state.items, {
        kind: 'message',
        id: userItemId,
        role: 'user',
        content: displayText,
        images: imageUrls.length ? imageUrls : undefined,
        attachments: attachments.length ? attachments : undefined,
        at: sentAt
      })
    })
    assistantId = null
    reasoningId = null
    const continuingRunId = runId
    if (continuingRunId) {
      awaitingRun = false
      patch({
        pendingRun: true,
        running: true,
        runStartedAt: Date.now(),
        runId: continuingRunId
      })
    } else {
      closeRun(runId)
      runId = null
      awaitingRun = true
      patch({ pendingRun: true, running: true, runStartedAt: Date.now(), runId: null })
    }
    const mode = getAgentMode?.() ?? 'agent'
    const startPayload = continuingRunId
      ? {
          incremental: true as const,
          newMessages: [user],
          workspacePath,
          runId: continuingRunId,
          mode
        }
      : {
          messages: nextMessages,
          workspacePath,
          mode
        }
    let res = await window.vyotiq.chatStart(startPayload)
    for (let attempt = 2; attempt <= CHAT_START_MAX_ATTEMPTS && !res.ok; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, CHAT_START_RETRY_MS))
      res = await window.vyotiq.chatStart(startPayload)
    }
    if (!res.ok) {
      awaitingRun = false
      // Detail in the log line — string `err` keeps scrubbed text; AppError would not.
      logger.error(`chatStart failed: ${res.error}`, { scope: 'chat', err: res.error })
      patch({
        error: res.error,
        running: false,
        runStartedAt: null,
        pendingRun: false,
        runId: null,
        messages: priorMessages,
        items: state.items.filter((item) => item.id !== userItemId)
      })
      return false
    }
    if (pendingCancel) {
      pendingCancel = false
      awaitingRun = false
      supersededInvokeIds.add(res.data.invokeId)
      closeRun(res.data.runId)
      runId = null
      // Clear the pre-run "Stopping…" notice — chatCancel does not emit a
      // terminal status for a run that never started streaming.
      patch({
        pendingRun: false,
        running: false,
        runStartedAt: null,
        runId: null,
        runNotice: null
      })
      const cancelRes = await window.vyotiq.chatCancel(res.data.runId)
      if (!cancelRes.ok) {
        logger.warn('chatCancel failed after pending stop', {
          scope: 'chat',
          correlationId: res.data.runId,
          err: cancelRes.error
        })
      }
      return true
    }
    if (!closedRuns.has(res.data.runId)) {
      assignRunId(res.data.runId)
    }
    activeInvokeId = res.data.invokeId
    supersededInvokeIds.delete(res.data.invokeId)
    awaitingRun = false
    return true
  }

  const editAndResend = async (
    editMessageIndex: number,
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ): Promise<boolean> => {
    const trimmed = text.trim()
    const hasExtras = Boolean(extras?.audio?.length || extras?.nativeFiles?.length)
    if ((!trimmed && !images?.length && !files?.length && !hasExtras) || state.transcriptLoading) {
      return false
    }
    if (!workspacePath) {
      patch({ error: 'Pick a workspace before editing a prompt.' })
      return false
    }
    const id = runId ?? contentRunId
    if (!id) {
      patch({ error: 'No run to edit. Send a message first.' })
      return false
    }
    if (
      editMessageIndex < 0 ||
      editMessageIndex >= state.messages.length ||
      state.messages[editMessageIndex]?.role !== 'user'
    ) {
      patch({ error: 'Cannot edit that message.' })
      return false
    }

    const content = buildUserContent(text, images, files, extras)
    const user: ChatMessage = { role: 'user', content }
    const priorMessages = state.messages
    const priorItems = state.items
    const priorFollowUps = state.pendingFollowUps
    const priorIncomplete = state.incomplete
    const priorWriteCheckpoint = state.writeCheckpoint
    const priorCollapsed = state.collapsedTurnIndices
    const nextMessages = messagesForNextTurn([...priorMessages.slice(0, editMessageIndex), user])
    const sentAt = new Date().toISOString()
    const editedUserId = messageUiId('user', editMessageIndex)
    const nextItems = carryTimingFromPriorItems(
      messagesToUiItems(nextMessages),
      priorItems
    ).map((item) => {
      if (item.kind === 'message' && item.role === 'user' && item.id === editedUserId) {
        return { ...item, at: sentAt }
      }
      return item
    })

    patch({
      error: null,
      runNotice: null,
      incomplete: null,
      writeCheckpoint: null,
      pendingFollowUps: [],
      collapsedTurnIndices: priorCollapsed.filter((i) => i <= editMessageIndex),
      messages: nextMessages,
      items: nextItems
    })

    lastRunErrorMessage = null
    usageTotals = emptyStepUsageTotals()
    pendingCancel = false
    ignoreStreamEvents = false
    if (activeInvokeId != null) supersededInvokeIds.add(activeInvokeId)
    activeInvokeId = null
    turnSeq += 1
    assistantId = null
    reasoningId = null
    toolContentCache.clear()

    awaitingRun = true
    patch({
      pendingRun: true,
      running: true,
      runStartedAt: Date.now(),
      runId: id
    })

    const mode = getAgentMode?.() ?? 'agent'
    const res = await window.vyotiq.chatRewindAndStart({
      workspacePath,
      runId: id,
      editMessageIndex,
      editedUserMessage: user,
      mode
    })

    if (!res.ok) {
      awaitingRun = false
      logger.error('chatRewindAndStart failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      patch({
        error: res.error,
        running: false,
        runStartedAt: null,
        pendingRun: false,
        messages: priorMessages,
        items: priorItems,
        pendingFollowUps: priorFollowUps,
        incomplete: priorIncomplete,
        writeCheckpoint: priorWriteCheckpoint,
        collapsedTurnIndices: priorCollapsed
      })
      return false
    }

    if (pendingCancel) {
      pendingCancel = false
      awaitingRun = false
      supersededInvokeIds.add(res.data.invokeId)
      closeRun(res.data.runId)
      runId = null
      patch({
        pendingRun: false,
        running: false,
        runStartedAt: null,
        runId: null,
        runNotice: null
      })
      const cancelRes = await window.vyotiq.chatCancel(res.data.runId)
      if (!cancelRes.ok) {
        logger.warn('chatCancel failed after pending stop (rewind)', {
          scope: 'chat',
          correlationId: res.data.runId,
          err: cancelRes.error
        })
      }
      return true
    }

    if (!closedRuns.has(res.data.runId)) {
      assignRunId(res.data.runId)
    }
    activeInvokeId = res.data.invokeId
    supersededInvokeIds.delete(res.data.invokeId)
    awaitingRun = false
    return true
  }

  const revertToUserMessage = async (userMessageIndex: number): Promise<boolean> => {
    if (state.transcriptLoading) return false
    if (!workspacePath) {
      patch({ error: 'Pick a workspace before reverting.' })
      return false
    }
    const id = runId ?? contentRunId
    if (!id) {
      patch({ error: 'No run to revert.' })
      return false
    }
    if (
      userMessageIndex < 0 ||
      userMessageIndex >= state.messages.length ||
      state.messages[userMessageIndex]?.role !== 'user'
    ) {
      patch({ error: 'Cannot revert to that message.' })
      return false
    }
    if (state.messages.length <= userMessageIndex + 1) {
      patch({ error: 'Nothing to revert after that prompt.' })
      return false
    }
    if (state.running || state.pendingRun) {
      patch({ error: 'Wait for the run to finish before reverting.' })
      return false
    }

    const priorMessages = state.messages
    const priorItems = state.items
    const priorFollowUps = state.pendingFollowUps
    const priorIncomplete = state.incomplete
    const priorWriteCheckpoint = state.writeCheckpoint
    const priorCollapsed = state.collapsedTurnIndices
    const nextMessages = priorMessages.slice(0, userMessageIndex + 1)
    const nextItems = carryTimingFromPriorItems(
      messagesToUiItems(nextMessages),
      priorItems
    )

    patch({
      error: null,
      runNotice: null,
      incomplete: null,
      writeCheckpoint: null,
      pendingFollowUps: [],
      collapsedTurnIndices: priorCollapsed.filter((i) => i <= userMessageIndex),
      messages: nextMessages,
      items: nextItems
    })

    toolContentCache.clear()
    assistantId = null
    reasoningId = null

    const res = await window.vyotiq.chatRewind({
      workspacePath,
      runId: id,
      userMessageIndex
    })

    if (!res.ok) {
      logger.error('chatRewind failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      patch({
        error: res.error,
        messages: priorMessages,
        items: priorItems,
        pendingFollowUps: priorFollowUps,
        incomplete: priorIncomplete,
        writeCheckpoint: priorWriteCheckpoint,
        collapsedTurnIndices: priorCollapsed
      })
      return false
    }

    const authoritativeItems = carryTimingFromPriorItems(
      messagesToUiItems(res.data.messages),
      priorItems
    )
    patch({
      messages: res.data.messages,
      items: authoritativeItems,
      writeCheckpoint: null
    })
    return true
  }

  const followUp = async (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ): Promise<boolean> => {
    const trimmed = text.trim()
    const id = runId
    const hasExtras = Boolean(extras?.audio?.length || extras?.nativeFiles?.length)
    if ((!trimmed && !images?.length && !files?.length && !hasExtras) || !state.running) return false
    if (!id) {
      patch({
        error: state.pendingRun
          ? 'Wait for the run to start before sending a follow-up.'
          : 'No active run to follow up on.'
      })
      return false
    }
    if (!workspacePath) {
      patch({ error: 'Pick a workspace before sending a follow-up.' })
      return false
    }
    const content = buildUserContent(text, images, files, extras)
    const user: ChatMessage = { role: 'user', content }
    const displayText = contentDisplayText(content)
    const preview = displayText.trim() || (uiAttachments(content).length ? uiAttachments(content)[0]!.name : 'Follow-up')
    const res = await window.vyotiq.chatFollowUp({ runId: id, message: user })
    if (!res.ok) {
      logger.warn('chatFollowUp failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      patch({ error: res.error })
      return false
    }
    patch({
      pendingFollowUps: [
        ...state.pendingFollowUps.filter((entry) => entry.id !== res.data.id),
        {
          id: res.data.id,
          itemId: `followup-${res.data.id}`,
          preview,
          text: displayText.trim() || preview,
          message: user
        }
      ]
    })
    return true
  }

  const removeFollowUp = async (followUpId: string): Promise<boolean> => {
    const id = runId
    const pending = state.pendingFollowUps.find((entry) => entry.id === followUpId)
    if (!id || !pending) return false
    const res = await window.vyotiq.chatFollowUpRemove({ runId: id, id: followUpId })
    if (!res.ok) {
      logger.warn('chatFollowUpRemove failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      return false
    }
    const nextPending = state.pendingFollowUps.filter((entry) => entry.id !== followUpId)
    patch({ pendingFollowUps: nextPending })
    return true
  }

  const editFollowUp = async (followUpId: string, text: string): Promise<boolean> => {
    const id = runId
    const pending = state.pendingFollowUps.find((entry) => entry.id === followUpId)
    const trimmed = text.trim()
    if (!id || !pending || !state.running || !trimmed) return false
    const content = mergeUserFollowUpText(pending.message?.content, trimmed)
    const user: ChatMessage = { role: 'user', content }
    const res = await window.vyotiq.chatFollowUpUpdate({ runId: id, id: followUpId, message: user })
    if (!res.ok) {
      logger.warn('chatFollowUpUpdate failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      patch({ error: res.error })
      return false
    }
    patch({
      pendingFollowUps: state.pendingFollowUps.map((entry) =>
        entry.id === followUpId
          ? { ...entry, preview: res.data.preview, text: trimmed, message: user }
          : entry
      )
    })
    return true
  }

  const sendFollowUpNow = async (followUpId: string): Promise<boolean> => {
    const id = runId
    if (!id || !state.running) return false
    if (!state.pendingFollowUps.some((entry) => entry.id === followUpId)) return false
    const res = await window.vyotiq.chatFollowUpPromote({ runId: id, id: followUpId })
    if (!res.ok) {
      logger.warn('chatFollowUpPromote failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      patch({ error: res.error })
      return false
    }
    const nextPending = [...state.pendingFollowUps]
    const idx = nextPending.findIndex((entry) => entry.id === followUpId)
    if (idx > 0) {
      const [item] = nextPending.splice(idx, 1)
      nextPending.unshift(item)
      patch({ pendingFollowUps: nextPending })
    }
    return true
  }

  const clearPendingFollowUps = (removeItems: boolean): void => {
    if (state.pendingFollowUps.length === 0) return
    const pending = state.pendingFollowUps
    const itemIds = new Set(pending.map((entry) => entry.itemId))
    let nextMessages = state.messages
    if (removeItems) {
      nextMessages = [...state.messages]
      const indices = pending
        .map((entry) => {
          const match = /^user-(\d+)$/.exec(entry.itemId)
          return match ? Number(match[1]) : -1
        })
        .filter((idx) => idx >= 0)
        .sort((a, b) => b - a)
      for (const idx of indices) {
        if (nextMessages[idx]?.role === 'user') {
          nextMessages.splice(idx, 1)
        }
      }
      // Drop any remaining by preview (reattach / echo itemIds).
      for (const entry of pending) {
        if (/^user-\d+$/.test(entry.itemId)) continue
        for (let i = nextMessages.length - 1; i >= 0; i--) {
          const msg = nextMessages[i]
          if (msg?.role === 'user' && contentDisplayText(msg.content) === entry.preview) {
            nextMessages.splice(i, 1)
            break
          }
        }
      }
    }
    patch({
      pendingFollowUps: [],
      ...(removeItems
        ? {
            items: state.items.filter((item) => !itemIds.has(item.id)),
            messages: nextMessages
          }
        : {})
    })
  }

  const syncFromDisk = async (
    id: string,
    opts?: { ignoreActiveList?: boolean }
  ): Promise<boolean> => {
    if (closedRuns.has(id) || disposed) return false
    // Brief listActiveRuns misses must not force idle while main is still streaming.
    if (!opts?.ignoreActiveList && window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (active.ok && active.data.some((entry) => entry.runId === id)) {
        return false
      }
    }
    if (closedRuns.has(id) || disposed) return false
    if (!window.vyotiq?.loadRun) return false
    const res = await window.vyotiq.loadRun(workspacePath, id)
    if (!res.ok) {
      logger.warn('syncFromDisk loadRun failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      return false
    }
    // Re-check after awaits — run may have resumed / re-registered.
    if (!opts?.ignoreActiveList && window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (active.ok && active.data.some((entry) => entry.runId === id)) {
        return false
      }
    }
    if (closedRuns.has(id) || disposed) return false
    let events: PersistedEvent[] = []
    let eventsLoadError: string | null = null
    if (window.vyotiq.loadRunEvents) {
      const eventsRes = await window.vyotiq.loadRunEvents(workspacePath, id)
      if (eventsRes.ok) events = eventsRes.data
      else eventsLoadError = eventsRes.error
    }
    const kept = messagesForNextTurn(res.data.messages)
    assistantId = null
    reasoningId = null
    runId = null
    contentRunId = id
    awaitingRun = false
    pendingCancel = false
    const mode = modeFromPersisted(events)
    if (mode) onAgentModeChange?.(mode)
    patch({
      ...hydrateFromDisk(kept, events, dismissedErrorMessage),
      ...(eventsLoadError ? { error: eventsLoadError } : {}),
      runId: null,
      pendingRun: false,
      running: false,
      runStartedAt: null,
      runTerminalTick: state.runTerminalTick + 1
    })
    onTerminal?.()
    return true
  }

  const recoverAfterCancelFailure = async (id: string, cancelError: string): Promise<void> => {
    if (/not found/i.test(cancelError)) {
      const synced = await syncFromDisk(id)
      if (synced) return
    }
    const deadline = Date.now() + CANCEL_RECOVERY_TIMEOUT_MS
    let runStillActive = false
    while (Date.now() < deadline) {
      const active = await window.vyotiq.listActiveRuns?.()
      if (active?.ok) {
        runStillActive = active.data.some((entry) => entry.runId === id)
        if (!runStillActive) {
          const synced = await syncFromDisk(id)
          if (synced) return
          break
        }
      }
      await sleep(CANCEL_RECOVERY_POLL_MS)
    }
    if (runStillActive) {
      // Stop failed and main is still streaming — keep the composer locked and
      // let the eventual terminal status (or a later disk sync) settle the run
      // instead of unlocking over live events. Stop stays clickable for a manual
      // retry; meanwhile keep retrying in the background so a transient IPC
      // failure cannot strand the UI in a running state forever.
      patch({ error: `${cancelError} Click Stop to retry.` })
      const retryDeadline = Date.now() + CANCEL_BACKGROUND_RETRY_MS
      while (Date.now() < retryDeadline) {
        await sleep(CANCEL_BACKGROUND_RETRY_EVERY_MS)
        if (closedRuns.has(id) || disposed) return
        const retry = await window.vyotiq.chatCancel(id)
        if (retry.ok) return // terminal events settle the UI via the normal path
        const active = await window.vyotiq.listActiveRuns?.()
        const stillActive = active?.ok ? active.data.some((entry) => entry.runId === id) : false
        if (!stillActive) {
          const synced = await syncFromDisk(id)
          if (synced) return
          break
        }
      }
      return
    }
    discardPendingStreamPatches()
    patch({
      error: cancelError,
      running: false,
      pendingRun: false,
      runStartedAt: null,
      runTerminalTick: state.runTerminalTick + 1,
      items: finalizeTerminalItems(state.items, 'Cancelled')
    })
    clearPendingFollowUps(true)
    onTerminal?.()
  }

  const stop = async (): Promise<void> => {
    const id = runId
    if (!id) {
      pendingCancel = true
      if (state.pendingRun || state.running || awaitingRun) {
        patch({ runNotice: 'Stopping…' })
      }
      return
    }
    // Do not clear follow-ups before cancel succeeds — a failed cancel would
    // drop UI rows while main still holds the queue.
    const res = await window.vyotiq.chatCancel(id)
    if (!res.ok) {
      logger.warn('chatCancel failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      await recoverAfterCancelFailure(id, res.error)
      return
    }
    // Successful cancel: terminal status clears follow-ups; clear optimistically
    // only after main accepted cancel so a failed cancel cannot lose UI state.
    clearPendingFollowUps(true)
  }

  const reset = (): void => {
    const id = runId
    if (id) {
      closeRun(id)
      void window.vyotiq.chatCancel(id).then(async (res) => {
        if (!res.ok) await recoverAfterCancelFailure(id, res.error)
      })
      awaitingRun = false
      clearSessionUi()
      return
    }
    if (awaitingRun) {
      pendingCancel = true
      clearSessionUi({ preservePendingCancel: true })
      return
    }
    clearSessionUi()
    awaitingRun = false
  }

  const applyTranscriptUi = (loaded: ChatMessage[], events?: PersistedEvent[]): void => {
    const kept = messagesForNextTurn(loaded)
    const rows = events ?? []
    assistantId = null
    reasoningId = null
    if (activeInvokeId != null) supersededInvokeIds.add(activeInvokeId)
    activeInvokeId = null
    usageTotals = emptyStepUsageTotals()
    toolContentCache.clear()
    const mode = modeFromPersisted(rows)
    if (mode) onAgentModeChange?.(mode)
    patch({
      ...hydrateFromDisk(kept, rows, dismissedErrorMessage)
    })
  }

  /** Replace session UI and cancel any in-flight run on this controller. */
  const loadTranscript = (loaded: ChatMessage[], events?: PersistedEvent[]): void => {
    const id = runId
    if (id) {
      closeRun(id)
      void window.vyotiq.chatCancel(id).then(async (res) => {
        if (!res.ok) await recoverAfterCancelFailure(id, res.error)
      })
      pendingCancel = false
      awaitingRun = false
    } else if (awaitingRun) {
      pendingCancel = true
      awaitingRun = false
    } else {
      pendingCancel = false
    }
    runId = null
    contentRunId = null
    patch({
      pendingRun: false,
      running: false,
      runId: null,
      runStartedAt: null,
      collapsedTurnIndices: []
    })
    applyTranscriptUi(loaded, events)
  }

  /** Hydrate UI from disk without canceling — used for restore and tab select. */
  const hydrateTranscript = (loaded: ChatMessage[], events?: PersistedEvent[]): void => {
    if (disposed) return
    // Never clobber an in-flight live stream with a lagging disk snapshot.
    if (state.running || state.pendingRun || awaitingRun) return
    applyTranscriptUi(loaded, events)
  }

  const reattachActiveRun = async (id: string): Promise<void> => {
    if (closedRuns.has(id) || disposed) return
    // Poll can race terminal status while main unwinds — don't resurrect a finished turn.
    if (!state.running && state.runTerminalTick > 0 && state.runId === id) {
      await syncFromDisk(id, { ignoreActiveList: true })
      return
    }
    // Poll/mount can race a terminal status — verify the run is still live.
    let liveInvokeId: number | null = null
    let pendingFromMain: { id: string; preview: string }[] = []
    if (window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (!active.ok || !active.data.some((entry) => entry.runId === id)) {
        await syncFromDisk(id)
        return
      }
      const live = active.data.find((entry) => entry.runId === id)
      liveInvokeId = live?.invokeId ?? null
      pendingFromMain = live?.pendingFollowUps ?? []
    }
    if (closedRuns.has(id) || disposed) return
    runId = id
    contentRunId = id
    // Live reattach must accept new events even if a prior terminal set ignoreStreamEvents.
    ignoreStreamEvents = false
    if (liveInvokeId != null) activeInvokeId = liveInvokeId
    const hydratedPending: PendingFollowUpState[] =
      pendingFromMain.length > 0
        ? pendingFromMain.map((entry) => {
            const local = state.pendingFollowUps.find((p) => p.id === entry.id)
            return {
              id: entry.id,
              // Prefer live optimistic itemIds (`user-N`) so remove/stop can roll back messages.
              itemId: local?.itemId ?? `followup-${entry.id}`,
              preview: local?.preview ?? entry.preview,
              text: local?.text ?? entry.preview
            }
          })
        : state.pendingFollowUps

    if (!window.vyotiq?.loadRun) {
      patch({
        runId: id,
        running: true,
        pendingRun: false,
        runStartedAt: state.runStartedAt ?? Date.now(),
        error: null,
        pendingFollowUps: hydratedPending
      })
      return
    }
    const res = await window.vyotiq.loadRun(workspacePath, id)
    if (closedRuns.has(id) || disposed) return
    // TOCTOU: run may have finished while we loaded disk.
    if (window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (!active.ok || !active.data.some((entry) => entry.runId === id)) {
        await syncFromDisk(id)
        return
      }
      const live = active.data.find((entry) => entry.runId === id)
      if (live?.invokeId != null) activeInvokeId = live.invokeId
      if (live?.pendingFollowUps) {
        pendingFromMain = live.pendingFollowUps
      }
    }
    if (!res.ok) {
      logger.warn('reattachActiveRun loadRun failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      // Still mark running if list said live — live events will catch up.
      patch({
        runId: id,
        running: true,
        pendingRun: false,
        runStartedAt: state.runStartedAt ?? Date.now(),
        error: null,
        pendingFollowUps: hydratedPending
      })
      return
    }
    let events: PersistedEvent[] = []
    let eventsLoadError: string | null = null
    if (window.vyotiq.loadRunEvents) {
      const eventsRes = await window.vyotiq.loadRunEvents(workspacePath, id)
      if (closedRuns.has(id) || disposed) return
      if (eventsRes.ok) events = eventsRes.data
      else eventsLoadError = eventsRes.error
    }
    // Final active check before committing running:true + hydrate.
    if (window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (!active.ok || !active.data.some((entry) => entry.runId === id)) {
        await syncFromDisk(id)
        return
      }
    }
    const kept = messagesForNextTurn(res.data.messages)
    const mode = modeFromPersisted(events)
    if (mode) onAgentModeChange?.(mode)
    const refreshedPending: PendingFollowUpState[] =
      pendingFromMain.length > 0
        ? pendingFromMain.map((entry) => {
            const local = state.pendingFollowUps.find((p) => p.id === entry.id)
            return {
              id: entry.id,
              itemId: local?.itemId ?? `followup-${entry.id}`,
              preview: local?.preview ?? entry.preview,
              text: local?.text ?? entry.preview,
              ...(local?.message ? { message: local.message } : {})
            }
          })
        : hydratedPending
    // Empty transcript: full hydrate. Existing items: refresh messages + timestamps
    // without clobbering live rows that arrived during the load await.
    if (state.items.length === 0) {
      patch({
        ...hydrateFromDisk(kept, events, dismissedErrorMessage),
        runId: id,
        running: true,
        pendingRun: false,
        runStartedAt: state.runStartedAt ?? Date.now(),
        error: eventsLoadError,
        pendingFollowUps: refreshedPending
      })
    } else {
      patch({
        runId: id,
        running: true,
        pendingRun: false,
        runStartedAt: state.runStartedAt ?? Date.now(),
        error: eventsLoadError,
        pendingFollowUps: refreshedPending,
        messages: kept,
        ...(events.length > 0 ? { items: applyEventTimestamps(state.items, events) } : {})
      })
    }
  }

  const setToolExpanded = (toolCallId: string, expanded: boolean): void => {
    patch({
      items: state.items.map((item) =>
        item.kind === 'tool' && (item.id === toolCallId || item.tool.id === toolCallId)
          ? { ...item, toolExpanded: expanded }
          : item
      )
    })
  }

  const setGroupExpanded = (anchorToolCallId: string, expanded: boolean): void => {
    patch({
      items: state.items.map((item) =>
        item.kind === 'tool' && (item.id === anchorToolCallId || item.tool.id === anchorToolCallId)
          ? { ...item, groupExpanded: expanded }
          : item
      )
    })
  }

  const handleApprovalRequest = (request: ToolApprovalRequest): void => {
    if (closedRuns.has(request.runId)) return
    if (runId && request.runId !== runId) return

    const approval = {
      requestId: request.requestId,
      toolName: request.name,
      summary: request.summary,
      argsPreview: request.argsPreview,
      mutating: request.mutating
    }

    const idx = findToolRowIndex(state.items, request.toolCallId, request.name)
    if (idx >= 0 && state.items[idx]?.kind === 'tool') {
      const item = state.items[idx]
      if (item.kind !== 'tool') return
      patch({
        items: replaceAt(state.items, idx, {
          ...item,
          approval
        })
      })
      return
    }

    // Tool row not yet visible — create a running stub so the approval card has a home.
    patch({
      items: appendTool(
        state.items,
        {
          kind: 'tool',
          id: request.toolCallId,
          at: new Date().toISOString(),
          approval,
          tool: withPresentationLock(
            {
              id: request.toolCallId,
              name: request.name,
              summary: request.summary,
              status: 'running',
              argsPreview: request.argsPreview
            },
            request.name,
            request.argsPreview
          )
        },
        state.runStartedAt
      )
    })
  }

  const respondToApproval = async (
    requestId: string,
    decision: ToolApprovalDecision
  ): Promise<void> => {
    if (!runId) {
      const message = 'No active run for approval response.'
      patch({ error: message })
      throw new Error(message)
    }
    const res = await window.vyotiq?.respondToolApproval?.(requestId, decision, runId)
    if (!res) {
      const message = 'Tool approval response is unavailable.'
      logger.warn('Tool approval response unavailable', { scope: 'chat' })
      patch({ error: message })
      throw new Error(message)
    }
    if (!res.ok) {
      logger.warn('Tool approval response rejected', {
        scope: 'chat',
        err: toLogErr(res.error)
      })
      patch({ error: res.error })
      throw new Error(res.error)
    }
    if (res.data !== true) {
      const message = 'Tool approval was not accepted. Try again.'
      logger.warn('Tool approval response not accepted', { scope: 'chat' })
      patch({ error: message })
      throw new Error(message)
    }
    patch({ items: clearApprovals(state.items, requestId), error: null })
  }

  const handleQuestionRequest = (request: AgentQuestionRequest): void => {
    if (closedRuns.has(request.runId)) return
    if (runId && request.runId !== runId) return

    const questionItem: Extract<UiItem, { kind: 'question' }> = {
      kind: 'question',
      id: `question:${request.requestId}`,
      question: {
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        ...(request.title ? { title: request.title } : {}),
        questions: request.questions.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          type: q.type,
          ...(q.options?.length ? { options: q.options } : {}),
          ...(q.allowCustom === true ? { allowCustom: true } : {})
        }))
      },
      at: new Date().toISOString()
    }
    const existingIdx = state.items.findIndex(
      (item) => item.kind === 'question' && item.question.requestId === request.requestId
    )
    if (existingIdx >= 0) {
      patch({ items: replaceAt(state.items, existingIdx, questionItem) })
      return
    }
    patch({ items: [...state.items, questionItem] })
  }

  const respondToQuestion = async (
    requestId: string,
    answers: AgentQuestionAnswer[]
  ): Promise<void> => {
    if (!runId) {
      const message = 'No active run for question response.'
      patch({ error: message })
      throw new Error(message)
    }
    const res = await window.vyotiq?.respondAgentQuestion?.(requestId, answers, runId)
    if (!res) {
      const message = 'Question response is unavailable.'
      logger.warn('Agent question response unavailable', { scope: 'chat' })
      patch({ error: message })
      throw new Error(message)
    }
    if (!res.ok) {
      logger.warn('Agent question response rejected', {
        scope: 'chat',
        err: toLogErr(res.error)
      })
      patch({ error: res.error })
      throw new Error(res.error)
    }
    // Main returns ok(false) when the requestId is unknown — leave the card so
    // the user can retry; otherwise the run stays parked with no UI.
    if (res.data !== true) {
      const message = 'Question answer was not accepted. Try again.'
      logger.warn('Agent question response not accepted', { scope: 'chat' })
      patch({ error: message })
      throw new Error(message)
    }
    patch({ items: clearQuestions(state.items, requestId), error: null })
  }

  const clearError = (): void => {
    if (state.error) dismissedErrorMessage = state.error
    patch({ error: null, errorCode: null })
  }

  const setThinkingExpanded = (messageId: string, expanded: boolean): void => {
    patch({
      items: state.items.map((item) =>
        item.kind === 'message' && item.id === messageId
          ? { ...item, thinkingExpanded: expanded }
          : item
      )
    })
  }

  const toggleTurnCollapsed = (turnIndex: number): void => {
    const collapsed = new Set(state.collapsedTurnIndices)
    if (!collapsed.delete(turnIndex)) collapsed.add(turnIndex)
    patch({ collapsedTurnIndices: [...collapsed] })
  }

  const patchToolContent = (toolCallId: string, content: string): void => {
    toolContentCache.set(toolCallId, content)
    const items = state.items
    const idx = findToolRowIndex(items, toolCallId)
    if (idx < 0 || items[idx]?.kind !== 'tool') return
    patch({
      items: items.map((item, i) =>
        i === idx && item.kind === 'tool'
          ? {
              ...item,
              tool: {
                ...item.tool,
                content,
                contentTruncated: false
              }
            }
          : item
      )
    })
  }

  const loadToolContent = async (toolCallId: string): Promise<string | null> => {
    const cached = toolContentCache.get(toolCallId)
    if (cached) return cached

    const id = runId ?? contentRunId
    if (!id || !window.vyotiq?.loadToolResult) return null

    const res = await window.vyotiq.loadToolResult(workspacePath, id, toolCallId)
    if (disposed) return null
    if (!res.ok) {
      logger.warn('loadToolResult failed', {
        scope: 'chat',
        correlationId: id,
        toolCallId,
        err: toLogErr(res.error)
      })
      const idx = findToolRowIndex(state.items, toolCallId)
      const item = idx >= 0 ? state.items[idx] : undefined
      if (item?.kind === 'tool') {
        const notice = "Couldn't load full output."
        patch({
          items: replaceAt(state.items, idx, {
            ...item,
            tool: {
              ...item.tool,
              content: item.tool.content ? `${item.tool.content}\n\n${notice}` : notice,
              // Stop expand retries from looping on a permanent failure.
              contentTruncated: false
            }
          })
        })
      }
      return null
    }
    patchToolContent(toolCallId, res.data.content)
    return res.data.content
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const subscribeItems = (listener: () => void): (() => void) => {
    itemsListeners.add(listener)
    return () => itemsListeners.delete(listener)
  }

  const subscribeMeta = (listener: () => void): (() => void) => {
    metaListeners.add(listener)
    return () => metaListeners.delete(listener)
  }

  const setTranscriptLoading = (loading: boolean): void => {
    if (disposed) return
    patch({ transcriptLoading: loading })
  }

  const applyManualCompaction = (result: {
    estimatedTokens?: number
    contextWindow?: number
    contentWindow?: number
    tokenEstimate: number
  }): void => {
    if (disposed) return
    const estimated = result.estimatedTokens ?? result.tokenEstimate
    const prev = state.contextUsage
    const summaryTokens = Math.max(0, result.tokenEstimate)
    const historyTokens = Math.max(0, estimated - summaryTokens)
    const window = result.contextWindow ?? prev?.window ?? 0
    const buffer = window > 0 ? allocateBudgetShares(window).buffer : 0
    // Summary is injected into system on the next assemble; kept turns are history.
    const compactLayers = {
      system: summaryTokens,
      history: historyTokens,
      tools: 0,
      buffer
    }
    patch({
      runNotice: 'Context summarized to stay within the model window.',
      contextUsage: prev
        ? {
            ...prev,
            used: estimated,
            estimatedTokens: estimated,
            inputTokens: undefined,
            source: 'estimate',
            window: result.contextWindow ?? prev.window,
            contentWindow: result.contentWindow ?? prev.contentWindow,
            layers: compactLayers,
            updatedAt: new Date().toISOString()
          }
        : result.contextWindow && result.contentWindow
          ? {
              step: 0,
              used: estimated,
              estimatedTokens: estimated,
              window: result.contextWindow,
              contentWindow: result.contentWindow,
              compactionTrigger: compactionTriggerFromRaw(
                result.contextWindow,
                DEFAULT_COMPACTION_TRIGGER_RATIO
              ),
              source: 'estimate',
              layers: compactLayers,
              stepUsage: emptyStepUsageTotals(),
              updatedAt: new Date().toISOString()
            }
          : prev
    })
  }

  const markWriteCheckpointUndone = (checkpointId?: string): void => {
    if (disposed) return
    const current = state.writeCheckpoint
    if (!current) return
    if (checkpointId && current.checkpointId !== checkpointId) return
    patch({
      writeCheckpoint: {
        ...current,
        undone: true,
        files: current.files.map((f) =>
          f.resolved ? f : { ...f, resolved: 'discarded' as const }
        )
      }
    })
  }

  const applyWriteCheckpointResolution = (result: {
    checkpointId: string
    kept: string[]
    discarded: string[]
    fullyResolved: boolean
  }): void => {
    if (disposed) return
    const current = state.writeCheckpoint
    if (!current || current.checkpointId !== result.checkpointId) return
    const kept = new Set(result.kept)
    const discarded = new Set(result.discarded)
    const files = current.files.map((f) => {
      if (kept.has(f.path)) return { ...f, resolved: 'kept' as const }
      if (discarded.has(f.path)) return { ...f, resolved: 'discarded' as const }
      return f
    })
    patch({
      writeCheckpoint: {
        ...current,
        files,
        undone: result.fullyResolved || files.every((f) => Boolean(f.resolved))
      }
    })
  }

  const dispose = (): void => {
    disposed = true
    flushStreamingPatches()
    listeners.clear()
    itemsListeners.clear()
    metaListeners.clear()
  }

  const controller: ChatStreamController = {
    get items() {
      return state.items
    },
    get messages() {
      return state.messages
    },
    get running() {
      return state.running
    },
    get runId() {
      return state.runId
    },
    get error() {
      return state.error
    },
    get errorCode() {
      return state.errorCode
    },
    get runNotice() {
      return state.runNotice
    },
    get incomplete() {
      return state.incomplete
    },
    get networkWait() {
      return state.networkWait
    },
    get contextUsage() {
      return state.contextUsage
    },
    get runStartedAt() {
      return state.runStartedAt
    },
    get runTerminalTick() {
      return state.runTerminalTick
    },
    get pendingRun() {
      return state.pendingRun
    },
    get transcriptLoading() {
      return state.transcriptLoading
    },
    get collapsedTurnIndices() {
      return state.collapsedTurnIndices
    },
    get writeCheckpoint() {
      return state.writeCheckpoint
    },
    get pendingFollowUps() {
      return state.pendingFollowUps
    },
    get disposed() {
      return disposed
    },
    get uiSuspended() {
      return uiSuspended
    },
    workspacePath,
    getInvokeId: () => activeInvokeId,
    send,
    editAndResend,
    revertToUserMessage,
    removeFollowUp,
    editFollowUp,
    sendFollowUpNow,
    stop,
    reset,
    loadTranscript,
    hydrateTranscript,
    reattachActiveRun,
    clearError,
    loadToolContent,
    setThinkingExpanded,
    setToolExpanded,
    setGroupExpanded,
    toggleTurnCollapsed,
    handleApprovalRequest,
    respondToApproval,
    handleQuestionRequest,
    respondToQuestion,
    syncFromDisk,
    applyManualCompaction,
    markWriteCheckpointUndone,
    applyWriteCheckpointResolution,
    handleEvent,
    setUiSuspended,
    resumeUiIfNeeded,
    subscribe,
    subscribeItems,
    subscribeMeta,
    getRevision,
    getItemsRevision,
    getMetaRevision,
    getContextUsage,
    setTranscriptLoading,
    dispose
  }

  return controller
}
