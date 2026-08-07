import { randomUUID } from 'crypto'
import { contentDisplayText, type AgentEvent, type AgentInteractionMode, type ChatMessage } from '../../shared/ipc'
import { userMessageDisplayText } from '../../shared/slashCommands'
import { cancelPendingQuestions } from './agentQuestion'

export type FollowUpEntry = {
  id: string
  message: ChatMessage
  /** True after the user clicks Send now — passive Enter-queue stays false until then. */
  ready?: boolean
}

type RunEntry = {
  controller: AbortController
  workspacePath: string
  invokeId: number
  /** True after a terminal event so follow-ups can start before cleanup finishes. */
  turnComplete: boolean
  /** Mid-run user messages waiting to inject into the live loop. */
  followUps: FollowUpEntry[]
  /**
   * Soft-abort for the current provider stream only. Distinct from `controller`
   * so Stop still cancels the whole turn while follow-ups only interrupt the stream.
   */
  streamInterrupt: AbortController | null
}

export type RunAbortHandle = {
  controller: AbortController
  invokeId: number
}

export type EnqueueFollowUpResult =
  | { ok: true; id: string; position: number; queueLength: number }
  | { ok: false; error: string }

const active = new Map<string, RunEntry>()
/** Composer mode queued for the next agent step (consumed by loop via takePendingMode). */
const pendingModeByRun = new Map<string, AgentInteractionMode>()
/** writes_checkpoint persisted in loop finally after the generator consumer ended. */
const lateWriteCheckpointByRun = new Map<string, AgentEvent>()
const lateFollowUpDroppedByRun = new Map<string, AgentEvent>()
let nextInvokeId = 1

/** Queue a mode switch to apply at the start of the next loop step. */
export function setPendingMode(runId: string, mode: AgentInteractionMode): void {
  pendingModeByRun.set(runId, mode)
}

/** Take and clear any queued mode switch for this run. */
export function takePendingMode(runId: string): AgentInteractionMode | undefined {
  const mode = pendingModeByRun.get(runId)
  if (mode !== undefined) pendingModeByRun.delete(runId)
  return mode
}

/** Loop finally may persist a checkpoint after the IPC consumer stopped yielding. */
export function setLateWriteCheckpoint(runId: string, event: AgentEvent): void {
  lateWriteCheckpointByRun.set(runId, event)
}

export function takeLateWriteCheckpoint(runId: string): AgentEvent | undefined {
  const event = lateWriteCheckpointByRun.get(runId)
  lateWriteCheckpointByRun.delete(runId)
  return event
}

/** Loop finally may drop follow-ups after the IPC consumer stopped yielding. */
export function setLateFollowUpDropped(runId: string, event: AgentEvent): void {
  lateFollowUpDroppedByRun.set(runId, event)
}

export function takeLateFollowUpDropped(runId: string): AgentEvent | undefined {
  const event = lateFollowUpDroppedByRun.get(runId)
  lateFollowUpDroppedByRun.delete(runId)
  return event
}

/** Register abort controller before the async loop starts so cancel works immediately. */
export function registerRunAbort(runId: string, workspacePath: string): RunAbortHandle {
  const existing = active.get(runId)
  // Reuse the live invoke. Never replace a turnComplete entry still unwinding —
  // overlapping runAgent finally blocks corrupt the same runDir.
  if (existing) {
    return { controller: existing.controller, invokeId: existing.invokeId }
  }

  const invokeId = nextInvokeId++
  const controller = new AbortController()
  active.set(runId, {
    controller,
    workspacePath,
    invokeId,
    turnComplete: false,
    followUps: [],
    streamInterrupt: null
  })
  return { controller, invokeId }
}

/**
 * Atomic register for IPC chatStart — rejects if a run slot already exists.
 * Single-threaded: check+set with no await in between.
 */
export function tryRegisterRunAbort(
  runId: string,
  workspacePath: string
): { ok: true; controller: AbortController; invokeId: number } | { ok: false; error: string } {
  if (active.has(runId)) {
    return { ok: false, error: 'Run is already active' }
  }
  const handle = registerRunAbort(runId, workspacePath)
  return { ok: true, controller: handle.controller, invokeId: handle.invokeId }
}

/**
 * Close the turn for follow-up enqueue atomically.
 * If follow-ups are already queued, leave the turn open so the loop can drain them.
 */
export function tryBeginRunClosing(
  runId: string,
  invokeId: number
): 'closed' | 'has_followups' | 'stale' {
  const entry = active.get(runId)
  if (!entry || entry.invokeId !== invokeId) return 'stale'
  if (entry.followUps.length > 0) return 'has_followups'
  entry.turnComplete = true
  entry.streamInterrupt = null
  return 'closed'
}

/** Allow follow-up enqueue to close; run stays in `active` until `clearRunAbort`. */
export function markRunTurnComplete(runId: string, invokeId: number): void {
  const entry = active.get(runId)
  if (entry && entry.invokeId === invokeId) {
    entry.turnComplete = true
    // Do not clear followUps here — a follow-up can land in the TOCTOU window
    // between the loop's last hasPendingFollowUps check and this mark. Queue is
    // cleared on cancel, drain, or clearRunAbort.
    entry.streamInterrupt = null
  }
}

type CancelGateWaitersOpts = {
  invokeId?: number
  /** Soft-steer: keep question prompts parked — they do not gate mutations, so the
   *  user can finish answering while their follow-up waits in the queue. */
  skipQuestions?: boolean
}

/** Clear parked approval/question waiters (lazy require for toolApproval avoids cycle). */
function cancelPendingGateWaiters(runId: string, opts?: CancelGateWaitersOpts): void {
  try {
    const { cancelPendingApprovals } = require('./toolApproval') as {
      cancelPendingApprovals: (runId: string, invokeId?: number) => void
    }
    cancelPendingApprovals(runId, opts?.invokeId)
  } catch {
    // ignore if modules unavailable in early boot / tests
  }
  if (!opts?.skipQuestions) {
    cancelPendingQuestions(runId, opts?.invokeId)
  }
}

/** Kill background terminal sessions immediately (lazy require avoids cycle). */
function disposeTerminalSessionsNow(runId: string, invokeId: number): void {
  try {
    const { disposeTerminalSessionsForInvoke } = require('./tools/terminalSessions') as {
      disposeTerminalSessionsForInvoke: (runId: string, invokeId: number) => number
    }
    disposeTerminalSessionsForInvoke(runId, invokeId)
  } catch {
    // ignore if modules unavailable in early boot / tests
  }
}

function cancelRunCore(runId: string): boolean {
  const entry = active.get(runId)
  if (!entry) return false
  entry.followUps = []
  entry.turnComplete = true
  entry.streamInterrupt?.abort()
  entry.streamInterrupt = null
  entry.controller.abort()
  cancelPendingGateWaiters(runId)
  disposeTerminalSessionsNow(runId, entry.invokeId)
  return true
}

export function cancelRun(runId: string): boolean {
  return cancelRunCore(runId)
}

export function getRunAbort(runId: string): AbortController | undefined {
  return active.get(runId)?.controller
}

export function getRunWorkspace(runId: string): string | undefined {
  return active.get(runId)?.workspacePath
}

export function isActive(runId: string): boolean {
  // True until clearRunAbort — includes the post-terminal unwind window so
  // chatStart cannot overlap a prior invoke's finally.
  return active.has(runId)
}

/** True after a terminal event while `finally` is still flushing/disposing. */
export function isRunTurnComplete(runId: string): boolean {
  return active.get(runId)?.turnComplete === true
}

/** Wait until `clearRunAbort` removes the run (bounded). Returns false on timeout. */
export async function waitUntilRunInactive(
  runId: string,
  timeoutMs = 15_000
): Promise<boolean> {
  const started = Date.now()
  while (isActive(runId)) {
    if (Date.now() - started >= timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

/** True when this invoke still owns the run slot (no newer follow-up registered). */
export function isCurrentInvoke(runId: string, invokeId: number): boolean {
  const entry = active.get(runId)
  return entry?.invokeId === invokeId
}

export type ActiveRunInfo = {
  runId: string
  workspacePath: string
  invokeId: number
  pendingFollowUps: { id: string; preview: string }[]
}

export function followUpPreview(message: ChatMessage): string {
  const text = userMessageDisplayText(contentDisplayText(message.content)).trim()
  if (text) return text
  const content = message.content
  if (typeof content !== 'string') {
    const file = content.find((part) => part.type === 'file')
    if (file?.name) return file.name
  }
  return 'Follow-up'
}

export function listActiveRuns(): ActiveRunInfo[] {
  return [...active.entries()].map(([runId, entry]) => ({
    runId,
    workspacePath: entry.workspacePath,
    invokeId: entry.invokeId,
    pendingFollowUps: entry.followUps.map((item) => ({
      id: item.id,
      preview: followUpPreview(item.message)
    }))
  }))
}

export function getRunInvokeId(runId: string): number | undefined {
  return active.get(runId)?.invokeId
}

export function clearRunAbort(runId: string, invokeId?: number): void {
  const entry = active.get(runId)
  if (!entry) return
  if (invokeId !== undefined && entry.invokeId !== invokeId) return
  active.delete(runId)
  pendingModeByRun.delete(runId)
  lateWriteCheckpointByRun.delete(runId)
  lateFollowUpDroppedByRun.delete(runId)
}

/** Queue a user message for mid-run injection (passive — does not interrupt). */
export function enqueueFollowUp(runId: string, message: ChatMessage): EnqueueFollowUpResult {
  const entry = active.get(runId)
  // Reject once the turn closed or the run abort fired — otherwise IPC can ack
  // follow_up_queued and clearRunAbort later drops the message unapplied.
  if (!entry || entry.turnComplete || entry.controller.signal.aborted) {
    return { ok: false, error: 'Run is not active' }
  }
  if (message.role !== 'user') {
    return { ok: false, error: 'Follow-up must be a user message' }
  }
  const id = randomUUID()
  entry.followUps.push({ id, message })
  // Passive queue — no stream interrupt. The composer shows the item until the
  // user clicks Send now (promoteFollowUp) or the loop drains at a step boundary.
  return {
    ok: true,
    id,
    position: entry.followUps.length,
    queueLength: entry.followUps.length
  }
}

/** Remove a still-queued follow-up before the loop applies it. */
export function removeFollowUp(
  runId: string,
  id: string
): { ok: true; removed: boolean; queueLength: number } | { ok: false; error: string } {
  const entry = active.get(runId)
  if (!entry || entry.turnComplete || entry.controller.signal.aborted) {
    return { ok: false, error: 'Run is not active' }
  }
  const before = entry.followUps.length
  entry.followUps = entry.followUps.filter((item) => item.id !== id)
  return {
    ok: true,
    removed: entry.followUps.length < before,
    queueLength: entry.followUps.length
  }
}

/** Replace a queued follow-up message before the loop applies it. */
export function updateFollowUp(
  runId: string,
  id: string,
  message: ChatMessage
): { ok: true; preview: string } | { ok: false; error: string } {
  const entry = active.get(runId)
  if (!entry || entry.turnComplete || entry.controller.signal.aborted) {
    return { ok: false, error: 'Run is not active' }
  }
  if (message.role !== 'user') {
    return { ok: false, error: 'Follow-up must be a user message' }
  }
  const queued = entry.followUps.find((item) => item.id === id)
  if (!queued) return { ok: false, error: 'Follow-up not found' }
  queued.message = message
  return { ok: true, preview: followUpPreview(message) }
}

/** Move a queued follow-up to the front and interrupt the live stream. */
export function promoteFollowUp(
  runId: string,
  id: string
): { ok: true; queueLength: number } | { ok: false; error: string } {
  const entry = active.get(runId)
  if (!entry || entry.turnComplete || entry.controller.signal.aborted) {
    return { ok: false, error: 'Run is not active' }
  }
  const idx = entry.followUps.findIndex((item) => item.id === id)
  if (idx < 0) return { ok: false, error: 'Follow-up not found' }
  const [item] = entry.followUps.splice(idx, 1)
  item.ready = true
  entry.followUps.unshift(item)
  entry.streamInterrupt?.abort()
  cancelPendingGateWaiters(runId, {
    invokeId: entry.invokeId,
    skipQuestions: true
  })
  return { ok: true, queueLength: entry.followUps.length }
}

export function hasPendingFollowUps(runId: string): boolean {
  const entry = active.get(runId)
  if (!entry || entry.turnComplete) return false
  return entry.followUps.length > 0
}

/** Follow-ups the user promoted with Send now — eligible for loop drain/steer. */
export function hasReadyFollowUps(runId: string): boolean {
  const entry = active.get(runId)
  if (!entry || entry.turnComplete) return false
  return entry.followUps.some((item) => item.ready)
}

export function peekFollowUps(runId: string): FollowUpEntry[] {
  const entry = active.get(runId)
  if (!entry) return []
  return entry.followUps.slice()
}

/** Take the next queued follow-up (FIFO), regardless of ready state — turn-end auto-apply. */
export function takeNextFollowUp(runId: string): FollowUpEntry | undefined {
  const entry = active.get(runId)
  if (!entry || entry.followUps.length === 0) return undefined
  return entry.followUps.shift()
}

/** Take the front follow-up only when promoted (Send now). */
export function takeNextReadyFollowUp(runId: string): FollowUpEntry | undefined {
  const entry = active.get(runId)
  if (!entry || entry.followUps.length === 0) return undefined
  if (!entry.followUps[0]?.ready) return undefined
  return entry.followUps.shift()
}

/** Take promoted follow-ups only (FIFO among ready items). */
export function drainReadyFollowUps(runId: string): FollowUpEntry[] {
  const drained: FollowUpEntry[] = []
  for (;;) {
    const next = takeNextReadyFollowUp(runId)
    if (!next) break
    drained.push(next)
  }
  return drained
}

/** Take all pending follow-ups (FIFO) — test/cleanup helper. */
export function drainFollowUps(runId: string): FollowUpEntry[] {
  const entry = active.get(runId)
  if (!entry) return []
  const drained = entry.followUps
  entry.followUps = []
  return drained
}

export function clearFollowUps(runId: string): void {
  const entry = active.get(runId)
  if (!entry) return
  entry.followUps = []
}

/** Bind a soft-abort controller for the current stream step. */
export function setStreamInterrupt(runId: string, controller: AbortController | null): void {
  const entry = active.get(runId)
  if (!entry) return
  entry.streamInterrupt = controller
}

export function getStreamInterrupt(runId: string): AbortController | undefined {
  return active.get(runId)?.streamInterrupt ?? undefined
}

/** Combined signal: run cancel OR soft stream interrupt. */
export function streamSignalFor(runId: string, runSignal: AbortSignal): AbortSignal {
  const entry = active.get(runId)
  const soft = entry?.streamInterrupt?.signal
  if (!soft) return runSignal
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([runSignal, soft])
  }
  // Fallback when AbortSignal.any is unavailable: mirror either abort into a local controller.
  if (runSignal.aborted || soft.aborted) {
    const done = new AbortController()
    done.abort()
    return done.signal
  }
  const combined = new AbortController()
  const onAbort = (): void => {
    runSignal.removeEventListener('abort', onAbort)
    soft.removeEventListener('abort', onAbort)
    if (!combined.signal.aborted) combined.abort()
  }
  runSignal.addEventListener('abort', onAbort, { once: true })
  soft.addEventListener('abort', onAbort, { once: true })
  return combined.signal
}

/** Test helper — clear active controllers between tests. */
export function resetActiveRunsForTests(): void {
  for (const entry of active.values()) {
    entry.streamInterrupt?.abort()
    entry.controller.abort()
  }
  active.clear()
  pendingModeByRun.clear()
  nextInvokeId = 1
}

/** Pure cancel helper (no Electron) — used by IPC and tests. */
export function chatCancelResult(
  runId: string
): { ok: true; data: true } | { ok: false; error: string } {
  if (!cancelRunCore(runId)) {
    return { ok: false, error: 'Run not found' }
  }
  return { ok: true, data: true }
}
