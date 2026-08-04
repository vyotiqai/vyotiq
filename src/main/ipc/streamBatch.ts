import type { AgentEvent } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { workspacePathsEqual } from '../../shared/workspacePathMatch'

const ACTIVE_BATCH_MS = 16
const BACKGROUND_BATCH_MS = 80

type PendingSegment =
  | { kind: 'text'; text: string; invokeId?: number }
  | { kind: 'thinking'; text: string; step?: number; invokeId?: number }
  | {
      kind: 'tool_call_delta'
      toolCallId: string
      name?: string
      argumentsDelta: string
      invokeId?: number
    }
  | {
      kind: 'terminal_output_delta'
      toolCallId: string
      text: string
      stream?: 'stdout' | 'stderr'
      invokeId?: number
    }

type RunSlot = {
  workspacePath: string
  send: (ev: AgentEvent) => void
  pendingSegments: PendingSegment[]
  /**
   * Background coalesce: latest usage event per step so inactive workspaces do
   * not lose earlier step meters when several arrive before activate.
   */
  pendingUsageByStep: Map<number, AgentEvent>
  /** Number of ChatEventBatcher owners; detach only when this hits 0. */
  attachCount: number
}

/** Dev/test counters for IPC send rate (Electron: measure before optimizing). */
export type ChatEventBatchStats = {
  pushed: number
  sent: number
  /** Pushes with no attached slot (not delivered). */
  dropped: number
  byType: Record<string, number>
  /** Timer flushes that prioritized an active-workspace run. */
  activeFlushes: number
  /** Timer flushes that only drained background runs (no active pending). */
  backgroundFlushes: number
  /** Background usage events that replaced a still-pending usage. */
  usageCoalesced: number
  /** Peak pending segment+usage depth since last reset. */
  maxPendingDepth: number
  attachedRuns: number
}

let stats: ChatEventBatchStats = {
  pushed: 0,
  sent: 0,
  dropped: 0,
  byType: {},
  activeFlushes: 0,
  backgroundFlushes: 0,
  usageCoalesced: 0,
  maxPendingDepth: 0,
  attachedRuns: 0
}

export function getChatEventBatchStats(): ChatEventBatchStats {
  return {
    pushed: stats.pushed,
    sent: stats.sent,
    dropped: stats.dropped,
    byType: { ...stats.byType },
    activeFlushes: stats.activeFlushes,
    backgroundFlushes: stats.backgroundFlushes,
    usageCoalesced: stats.usageCoalesced,
    maxPendingDepth: stats.maxPendingDepth,
    attachedRuns: stats.attachedRuns
  }
}

export function resetChatEventBatchStats(): void {
  stats = {
    pushed: 0,
    sent: 0,
    dropped: 0,
    byType: {},
    activeFlushes: 0,
    backgroundFlushes: 0,
    usageCoalesced: 0,
    maxPendingDepth: 0,
    attachedRuns: 0
  }
}

function recordPush(type: string): void {
  stats.pushed += 1
  stats.byType[type] = (stats.byType[type] ?? 0) + 1
}

function recordSend(type: string): void {
  stats.sent += 1
  const key = `sent:${type}`
  stats.byType[key] = (stats.byType[key] ?? 0) + 1
}

type ActivePathResolver = () => string | null

let resolveActivePath: ActivePathResolver = defaultActivePathResolver

function defaultActivePathResolver(): string | null {
  try {
    // Lazy require avoids circular import at module load (workspaces ↔ ipc).
    const { getWorkspaces } = require('../workspace/workspaces') as {
      getWorkspaces: () => { activePath: string | null }
    }
    return getWorkspaces().activePath
  } catch {
    return null
  }
}

/** @internal Override active-path lookup in unit tests. */
export function setChatEventActivePathResolver(resolver: ActivePathResolver | null): void {
  resolveActivePath = resolver ?? defaultActivePathResolver
}

function isActiveWorkspace(workspacePath: string): boolean {
  // Empty path = isolated/local batcher (unit tests) — treat as active (16ms).
  if (!workspacePath) return true
  const active = resolveActivePath()
  if (!active) return true
  return workspacePathsEqual(active, workspacePath)
}

function totalPendingDepth(slots: Map<string, RunSlot>): number {
  let n = 0
  for (const slot of slots.values()) {
    n += slot.pendingSegments.length
    n += slot.pendingUsageByStep.size
  }
  return n
}

/**
 * Single shared chat-event dispatcher: one timer, active-workspace runs flush first,
 * background runs coalesce longer and may drop intermediate usage under pressure.
 */
export class ChatEventDispatcher {
  private readonly slots = new Map<string, RunSlot>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextDueMs = 0

  attach(
    runId: string,
    workspacePath: string,
    send: (ev: AgentEvent) => void,
    options?: { retain?: boolean }
  ): void {
    const retain = options?.retain !== false
    const existing = this.slots.get(runId)
    if (existing) {
      existing.workspacePath = workspacePath
      existing.send = send
      if (retain) existing.attachCount += 1
      return
    }
    this.slots.set(runId, {
      workspacePath,
      send,
      pendingSegments: [],
      pendingUsageByStep: new Map(),
      attachCount: 1
    })
    stats.attachedRuns = this.slots.size
  }

  detach(runId: string): void {
    const slot = this.slots.get(runId)
    if (!slot) return
    slot.attachCount = Math.max(0, slot.attachCount - 1)
    if (slot.attachCount > 0) {
      this.flushRun(runId)
      return
    }
    this.flushRun(runId)
    this.slots.delete(runId)
    stats.attachedRuns = this.slots.size
    if (this.slots.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.nextDueMs = 0
    }
  }

  push(runId: string, ev: AgentEvent): void {
    const slot = this.slots.get(runId)
    if (!slot) {
      recordPush(ev.type)
      stats.dropped += 1
      logger.warn(`Chat event dropped: no attached slot (${ev.type})`, {
        scope: 'ipc',
        runId,
        kind: ev.type
      })
      return
    }
    recordPush(ev.type)

    if (ev.type === 'text_delta') {
      this.appendSegment(slot, { kind: 'text', text: ev.text, invokeId: ev.invokeId })
      this.schedule(slot.workspacePath)
      return
    }

    if (ev.type === 'thinking_delta') {
      this.appendSegment(slot, {
        kind: 'thinking',
        text: ev.text,
        step: ev.step,
        invokeId: ev.invokeId
      })
      this.schedule(slot.workspacePath)
      return
    }

    if (ev.type === 'tool_call_delta') {
      this.appendSegment(slot, {
        kind: 'tool_call_delta',
        toolCallId: ev.toolCallId,
        name: ev.name,
        argumentsDelta: ev.argumentsDelta,
        invokeId: ev.invokeId
      })
      this.schedule(slot.workspacePath)
      return
    }

    if (ev.type === 'terminal_output_delta') {
      this.appendSegment(slot, {
        kind: 'terminal_output_delta',
        toolCallId: ev.toolCallId,
        text: ev.text,
        stream: ev.stream,
        invokeId: ev.invokeId
      })
      this.schedule(slot.workspacePath)
      return
    }

    if (ev.type === 'step_usage' || ev.type === 'context_usage') {
      if (!isActiveWorkspace(slot.workspacePath)) {
        // Keep latest usage per step so background workspaces retain meters.
        const prev = slot.pendingUsageByStep.get(ev.step)
        if (prev) stats.usageCoalesced += 1
        slot.pendingUsageByStep.set(ev.step, ev)
        this.notePendingDepth()
        this.schedule(slot.workspacePath)
        return
      }
      this.flushAllDeltas()
      this.emit(slot, ev)
      return
    }

    this.flushAllDeltas()
    this.emit(slot, ev)
  }

  /** Flush one run (approvals / end of turn), or all runs when omitted. */
  flush(runId?: string): void {
    if (runId) {
      this.flushRun(runId)
      return
    }
    this.flushAllDeltas()
  }

  /** Current queue depth across attached runs. */
  pendingDepth(): number {
    return totalPendingDepth(this.slots)
  }

  attachedCount(): number {
    return this.slots.size
  }

  private flushPendingUsageEvents(slot: RunSlot): void {
    if (slot.pendingUsageByStep.size === 0) return
    const steps = [...slot.pendingUsageByStep.keys()].sort((a, b) => a - b)
    for (const step of steps) {
      const usageEv = slot.pendingUsageByStep.get(step)
      if (usageEv) this.emit(slot, usageEv)
    }
    slot.pendingUsageByStep.clear()
  }

  private flushRun(runId: string): void {
    const slot = this.slots.get(runId)
    if (!slot) return
    this.emitSegments(slot, runId, slot.pendingSegments)
    slot.pendingSegments = []
    this.flushPendingUsageEvents(slot)
  }

  private flushAllDeltas(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.nextDueMs = 0
    }

    const ordered = [...this.slots.entries()].sort(([, a], [, b]) => {
      const aActive = isActiveWorkspace(a.workspacePath) ? 0 : 1
      const bActive = isActiveWorkspace(b.workspacePath) ? 0 : 1
      return aActive - bActive
    })

    let flushedActive = false
    let flushedBackground = false
    for (const [runId, slot] of ordered) {
      const had =
        slot.pendingSegments.length > 0 || slot.pendingUsageByStep.size > 0
      if (!had) continue
      if (isActiveWorkspace(slot.workspacePath)) flushedActive = true
      else flushedBackground = true
      if (slot.pendingSegments.length) {
        this.emitSegments(slot, runId, slot.pendingSegments)
        slot.pendingSegments = []
      }
      this.flushPendingUsageEvents(slot)
    }
    if (flushedActive) stats.activeFlushes += 1
    else if (flushedBackground) stats.backgroundFlushes += 1
  }

  private notePendingDepth(): void {
    const depth = totalPendingDepth(this.slots)
    if (depth > stats.maxPendingDepth) stats.maxPendingDepth = depth
  }

  private schedule(workspacePath: string): void {
    this.notePendingDepth()
    const delay = isActiveWorkspace(workspacePath) ? ACTIVE_BATCH_MS : BACKGROUND_BATCH_MS
    const due = Date.now() + delay
    if (this.timer && this.nextDueMs > 0 && this.nextDueMs <= due) return
    if (this.timer) clearTimeout(this.timer)
    this.nextDueMs = due
    this.timer = setTimeout(() => {
      this.timer = null
      this.nextDueMs = 0
      this.flushAllDeltas()
    }, delay)
  }

  private emit(slot: RunSlot, ev: AgentEvent): void {
    recordSend(ev.type)
    slot.send(ev)
  }

  private appendSegment(slot: RunSlot, segment: PendingSegment): void {
    const queue = slot.pendingSegments
    const last = queue[queue.length - 1]
    if (
      last &&
      last.kind === segment.kind &&
      last.invokeId === segment.invokeId &&
      (segment.kind !== 'thinking' || (last.kind === 'thinking' && last.step === segment.step)) &&
      (segment.kind !== 'tool_call_delta' ||
        (last.kind === 'tool_call_delta' && last.toolCallId === segment.toolCallId)) &&
      (segment.kind !== 'terminal_output_delta' ||
        (last.kind === 'terminal_output_delta' &&
          last.toolCallId === segment.toolCallId &&
          last.stream === segment.stream))
    ) {
      if (segment.kind === 'thinking' && last.kind === 'thinking') {
        queue[queue.length - 1] = {
          kind: 'thinking',
          text: last.text + segment.text,
          step: segment.step,
          invokeId: segment.invokeId
        }
      } else if (segment.kind === 'text' && last.kind === 'text') {
        queue[queue.length - 1] = {
          kind: 'text',
          text: last.text + segment.text,
          invokeId: segment.invokeId
        }
      } else if (segment.kind === 'tool_call_delta' && last.kind === 'tool_call_delta') {
        queue[queue.length - 1] = {
          kind: 'tool_call_delta',
          toolCallId: last.toolCallId,
          name: segment.name ?? last.name,
          argumentsDelta: last.argumentsDelta + segment.argumentsDelta,
          invokeId: segment.invokeId
        }
      } else if (segment.kind === 'terminal_output_delta' && last.kind === 'terminal_output_delta') {
        queue[queue.length - 1] = {
          kind: 'terminal_output_delta',
          toolCallId: last.toolCallId,
          text: last.text + segment.text,
          stream: segment.stream,
          invokeId: segment.invokeId
        }
      }
    } else {
      queue.push(segment)
    }
  }

  private emitSegments(slot: RunSlot, runId: string, segments: PendingSegment[]): void {
    for (const segment of segments) {
      if (segment.kind === 'text') {
        if (!segment.text) continue
        this.emit(slot, {
          type: 'text_delta',
          runId,
          text: segment.text,
          invokeId: segment.invokeId
        })
      } else if (segment.kind === 'thinking') {
        if (!segment.text) continue
        this.emit(slot, {
          type: 'thinking_delta',
          runId,
          text: segment.text,
          step: segment.step,
          invokeId: segment.invokeId
        })
      } else if (segment.kind === 'tool_call_delta') {
        this.emit(slot, {
          type: 'tool_call_delta',
          runId,
          toolCallId: segment.toolCallId,
          name: segment.name,
          argumentsDelta: segment.argumentsDelta,
          invokeId: segment.invokeId
        })
      } else {
        if (!segment.text) continue
        this.emit(slot, {
          type: 'terminal_output_delta',
          runId,
          toolCallId: segment.toolCallId,
          text: segment.text,
          stream: segment.stream,
          invokeId: segment.invokeId
        })
      }
    }
  }
}

let sharedDispatcher: ChatEventDispatcher | null = null

export function getChatEventDispatcher(): ChatEventDispatcher {
  if (!sharedDispatcher) sharedDispatcher = new ChatEventDispatcher()
  return sharedDispatcher
}

/** Live dispatcher queue depth for load snapshots. */
export function getChatEventDispatcherSnapshot(): {
  pendingDepth: number
  attachedRuns: number
} {
  if (!sharedDispatcher) return { pendingDepth: 0, attachedRuns: 0 }
  return {
    pendingDepth: sharedDispatcher.pendingDepth(),
    attachedRuns: sharedDispatcher.attachedCount()
  }
}

/** @internal Reset singleton between tests. */
export function resetChatEventDispatcher(): void {
  if (sharedDispatcher) {
    sharedDispatcher.flush()
  }
  sharedDispatcher = null
  resetChatEventBatchStats()
}

export type ChatEventBatcherOptions = {
  runId: string
  workspacePath: string
  /** Default true when options provided. */
  shared?: boolean
}

/**
 * Per-run facade. Production chatStart uses the shared prioritized dispatcher.
 * Unit tests construct without options for an isolated local dispatcher.
 */
export class ChatEventBatcher {
  private readonly send: (ev: AgentEvent) => void
  private readonly fixedRunId: string | null
  private readonly workspacePath: string
  private readonly dispatcher: ChatEventDispatcher
  private readonly shared: boolean

  constructor(send: (ev: AgentEvent) => void, options?: ChatEventBatcherOptions) {
    this.send = send
    if (options?.runId && options.shared !== false) {
      this.fixedRunId = options.runId
      this.workspacePath = options.workspacePath
      this.shared = true
      this.dispatcher = getChatEventDispatcher()
      this.dispatcher.attach(options.runId, options.workspacePath, send)
    } else {
      this.fixedRunId = null
      this.workspacePath = ''
      this.shared = false
      this.dispatcher = new ChatEventDispatcher()
    }
  }

  push(ev: AgentEvent): void {
    const id = this.fixedRunId ?? ev.runId
    // Refresh send target without taking another retain (constructor/dispose own the count).
    this.dispatcher.attach(id, this.workspacePath, this.send, { retain: false })
    this.dispatcher.push(id, { ...ev, runId: id })
  }

  flush(): void {
    if (this.fixedRunId) {
      this.dispatcher.flush(this.fixedRunId)
      return
    }
    this.dispatcher.flush()
  }

  dispose(): void {
    if (this.shared && this.fixedRunId) {
      this.dispatcher.detach(this.fixedRunId)
    } else {
      this.dispatcher.flush()
    }
  }
}
