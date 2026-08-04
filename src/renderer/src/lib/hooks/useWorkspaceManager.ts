import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  AgentEvent,
  AgentInteractionMode,
  PersistedEvent,
  RunSummary,
  ToolApprovalRequest,
  ToolApprovalDecision,
  AgentQuestionRequest,
  WorkspaceSettingsOverride,
  WorkspaceUiState,
  WorkspacesState
} from '@shared/ipc'
import type { UiAgentQuestionAnswer } from '@shared/transcript'
import { toLogErr } from '@shared/errors'
import { logger } from '@shared/logger'
import { workspacePathsEqual, findByWorkspacePath } from '@shared/workspacePathMatch'
import {
  createChatStreamController,
  type ChatStreamController
} from './createChatStreamController'
import { ensureChatUiPerfDump } from './chatUiPerf'
import {
  clearWorkspaceHotUi,
  getWorkspaceHotUi,
  hasWorkspaceHotUi,
  seedWorkspaceHotUi,
  setWorkspaceHotUi
} from './workspaceHotUiStore'

const ACTIVE_RUNS_POLL_MS = 5_000
const ACTIVE_RUNS_WARN_INTERVAL_MS = 60_000

/** Rehydrate ask_question cards after remount while main is still waiting. */
async function restorePendingQuestions(
  controller: ChatStreamController,
  runId: string
): Promise<void> {
  if (!window.vyotiq?.listPendingAgentQuestions) return
  const res = await window.vyotiq.listPendingAgentQuestions(runId)
  if (!res.ok) return
  for (const request of res.data) {
    controller.handleQuestionRequest(request)
  }
}

/** Rehydrate tool-approval cards after remount while main is still waiting. */
async function restorePendingApprovals(
  controller: ChatStreamController,
  runId: string
): Promise<void> {
  if (!window.vyotiq?.listPendingToolApprovals) return
  const res = await window.vyotiq.listPendingToolApprovals(runId)
  if (!res.ok) return
  for (const request of res.data) {
    controller.handleApprovalRequest(request)
  }
}
const ORPHAN_SYNC_DEBOUNCE_MS = 600
const OPEN_RUN_TAB_LIMIT = 10
/** Cap orphan IPC buffers for runIds not yet mapped to a controller. */
const ORPHAN_EVENT_BUFFER_MAX = 128
const ORPHAN_APPROVAL_BUFFER_MAX = 16
const ORPHAN_QUESTION_BUFFER_MAX = 16
/** Prefer coalescing same-type usage under orphan backpressure instead of dropping. */
const ORPHAN_USAGE_TYPES = new Set<AgentEvent['type']>(['step_usage', 'context_usage'])

const ORPHAN_DELTA_TYPES = new Set<AgentEvent['type']>(['text_delta', 'thinking_delta'])
/** Never FIFO-drop these under backpressure while a non-critical remains (or incoming). */
const ORPHAN_CRITICAL_TYPES = new Set<AgentEvent['type']>([
  'tool_start',
  'tool_result',
  'tool_call_delta',
  'assistant_message',
  'thinking_done',
  'follow_up_queued',
  'follow_up_applied',
  'follow_up_dropped',
  'terminal_output_delta',
  'stream_reset',
  'status',
  'writes_checkpoint',
  'incomplete',
  'error',
  'tool_progress',
  'compaction',
  'mcp_tools_omitted',
  'mode_changed'
])
const UI_PERSIST_DEBOUNCE_MS = 300
const LIST_RUNS_DEBOUNCE_MS = 300

/**
 * Under orphan backpressure, drop an older usage event only when a later
 * same-type usage remains (latest meter wins). Never sacrifice the sole meter.
 */
function coalesceOldestOrphanUsage(buffered: AgentEvent[]): boolean {
  const dropIdx = buffered.findIndex((ev) => ORPHAN_USAGE_TYPES.has(ev.type))
  if (dropIdx < 0) return false
  const victim = buffered[dropIdx]!
  for (let i = dropIdx + 1; i < buffered.length; i++) {
    if (buffered[i]!.type === victim.type) {
      buffered.splice(dropIdx, 1)
      return true
    }
  }
  return false
}

/**
 * Under orphan backpressure, fold oldest tool_call_delta into a later delta for
 * the same toolCallId (arguments concatenate like the live stream path).
 */
function coalesceOldestOrphanToolCallDelta(buffered: AgentEvent[]): boolean {
  const dropIdx = buffered.findIndex((ev) => ev.type === 'tool_call_delta')
  if (dropIdx < 0) return false
  const victim = buffered[dropIdx]!
  if (victim.type !== 'tool_call_delta') return false
  for (let i = dropIdx + 1; i < buffered.length; i++) {
    const next = buffered[i]!
    if (next.type !== 'tool_call_delta') continue
    if (next.toolCallId !== victim.toolCallId) continue
    buffered[i] = {
      ...next,
      argumentsDelta: victim.argumentsDelta + next.argumentsDelta,
      ...(victim.name && !next.name ? { name: victim.name } : {})
    }
    buffered.splice(dropIdx, 1)
    return true
  }
  return false
}

/**
 * Under orphan backpressure, fold the oldest stream delta into a later same-type
 * delta so token text is preserved instead of discarded.
 */
function coalesceOldestOrphanDelta(buffered: AgentEvent[]): boolean {
  const dropIdx = buffered.findIndex((ev) => ORPHAN_DELTA_TYPES.has(ev.type))
  if (dropIdx < 0) return false
  const victim = buffered[dropIdx]!
  for (let i = dropIdx + 1; i < buffered.length; i++) {
    const next = buffered[i]!
    if (next.type !== victim.type) continue
    if (victim.type === 'text_delta' && next.type === 'text_delta') {
      buffered[i] = { ...next, text: victim.text + next.text }
      buffered.splice(dropIdx, 1)
      return true
    }
    if (victim.type === 'thinking_delta' && next.type === 'thinking_delta') {
      if (
        victim.step !== undefined &&
        next.step !== undefined &&
        victim.step !== next.step
      ) {
        continue
      }
      buffered[i] = { ...next, text: victim.text + next.text }
      buffered.splice(dropIdx, 1)
      return true
    }
  }
  return false
}

/** @internal Exported for tests. */
export const WORKSPACE_MANAGER_LIMITS = {
  OPEN_RUN_TAB_LIMIT,
  ORPHAN_EVENT_BUFFER_MAX,
  ORPHAN_APPROVAL_BUFFER_MAX,
  ORPHAN_QUESTION_BUFFER_MAX
} as const

export type WorkspaceUiSlice = {
  scrollTop: number
  scrollTopByRunId: Record<string, number>
  composerDraft: string
  agentMode: AgentInteractionMode
}

const DRAFT_SCROLL_KEY = '__draft__'

function scrollKeyForRun(runId: string | null): string {
  return runId ?? DRAFT_SCROLL_KEY
}

/** Keep scroll entries for open tabs and active run; draft only while drafting. @internal */
export function pruneScrollTopByRunId(
  scrollTopByRunId: Record<string, number>,
  keep: { openRunIds: string[]; activeRunId: string | null }
): Record<string, number> {
  const allowed = new Set<string>([...keep.openRunIds])
  if (keep.activeRunId) allowed.add(keep.activeRunId)
  else allowed.add(DRAFT_SCROLL_KEY)
  const next: Record<string, number> = {}
  for (const [key, value] of Object.entries(scrollTopByRunId)) {
    if (allowed.has(key)) next[key] = value
  }
  return next
}

/** Remove one deleted run's scroll entry. @internal */
export function omitRunScrollTop(
  scrollTopByRunId: Record<string, number>,
  runId: string
): Record<string, number> {
  if (!(runId in scrollTopByRunId)) return scrollTopByRunId
  const { [runId]: _removed, ...rest } = scrollTopByRunId
  return rest
}

/** Drop open tabs / active run that no longer exist on disk. @internal */
export function reconcileOpenRunIds(
  openRunIds: string[],
  activeRunId: string | null,
  runIdsOnDisk: string[],
  previouslyKnownRunIds: string[]
): { openRunIds: string[]; activeRunId: string | null; changed: boolean } {
  const existing = new Set(runIdsOnDisk)
  const stale = new Set(previouslyKnownRunIds.filter((id) => !existing.has(id)))
  if (stale.size === 0) {
    return { openRunIds, activeRunId, changed: false }
  }
  const pruned = openRunIds.filter((id) => !stale.has(id))
  let nextActive = activeRunId
  if (nextActive && stale.has(nextActive)) {
    nextActive = pruned[pruned.length - 1] ?? null
  }
  if (nextActive && !pruned.includes(nextActive)) {
    pruned.push(nextActive)
  }
  const changed =
    pruned.length !== openRunIds.length ||
    pruned.some((id, i) => id !== openRunIds[i]) ||
    nextActive !== activeRunId
  return { openRunIds: pruned, activeRunId: nextActive, changed }
}

export type WorkspaceContext = {
  path: string
  runs: RunSummary[]
  runsCapped: boolean
  runsError: string | null
  /** False until the first listRuns settles — drives the sidebar skeleton. */
  runsLoaded: boolean
  activeRunId: string | null
  openRunIds: string[]
  backgroundRunIds: Set<string>
  sessionQuery: string
  ui: WorkspaceUiSlice
  settingsOverride: WorkspaceSettingsOverride | null
}

function defaultUiState(): WorkspaceUiState {
  return {
    activeRunId: null,
    openRunIds: [],
    scrollTop: 0,
    scrollTopByRunId: {},
    composerDraft: '',
    agentMode: 'agent'
  }
}

function draftControllerKey(workspacePath: string): string {
  return `__draft__:${workspacePath}`
}

function uiStateFromContext(ctx: WorkspaceContext): WorkspaceUiState {
  const scrollTop =
    ctx.ui.scrollTopByRunId[scrollKeyForRun(ctx.activeRunId)] ?? ctx.ui.scrollTop
  return {
    activeRunId: ctx.activeRunId,
    openRunIds: [...ctx.openRunIds],
    scrollTop,
    scrollTopByRunId: pruneScrollTopByRunId(ctx.ui.scrollTopByRunId, {
      openRunIds: ctx.openRunIds,
      activeRunId: ctx.activeRunId
    }),
    composerDraft: ctx.ui.composerDraft,
    agentMode: ctx.ui.agentMode
  }
}

function contextFromRegistry(path: string, registry: WorkspacesState): WorkspaceContext {
  const ui = registry.uiStateByPath[path] ?? defaultUiState()
  let scrollTopByRunId = { ...(ui.scrollTopByRunId ?? {}) }
  if (ui.scrollTop > 0 && ui.activeRunId && scrollTopByRunId[ui.activeRunId] === undefined) {
    scrollTopByRunId[ui.activeRunId] = ui.scrollTop
  } else if (ui.scrollTop > 0 && !ui.activeRunId && scrollTopByRunId[DRAFT_SCROLL_KEY] === undefined) {
    scrollTopByRunId[DRAFT_SCROLL_KEY] = ui.scrollTop
  }
  scrollTopByRunId = pruneScrollTopByRunId(scrollTopByRunId, {
    openRunIds: ui.openRunIds ?? [],
    activeRunId: ui.activeRunId ?? null
  })
  return {
    path,
    runs: [],
    runsCapped: false,
    runsError: null,
    runsLoaded: false,
    activeRunId: ui.activeRunId,
    openRunIds: [...ui.openRunIds],
    backgroundRunIds: new Set(),
    sessionQuery: '',
    ui: {
      scrollTop: ui.scrollTop,
      scrollTopByRunId,
      composerDraft: ui.composerDraft,
      agentMode: ui.agentMode ?? 'agent'
    },
    settingsOverride:
      findSettingsOverride(registry.settingsOverridesByPath, path) ?? null
  }
}

function findSettingsOverride(
  overrides: WorkspacesState['settingsOverridesByPath'],
  path: string
): WorkspaceSettingsOverride | null {
  return findByWorkspacePath(overrides, path)
}

export function useWorkspaceManager() {
  const [registry, setRegistry] = useState<WorkspacesState | null>(null)
  const [contexts, setContexts] = useState<Record<string, WorkspaceContext>>({})
  const [activeRuns, setActiveRuns] = useState<{ runId: string; workspacePath: string }[]>([])
  const [revision, setRevision] = useState(0)
  const [scrollRestoreToken, setScrollRestoreToken] = useState(0)
  const [chatSurfaceEpoch, setChatSurfaceEpoch] = useState(0)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)

  const controllersRef = useRef(new Map<string, ChatStreamController>())
  const contextsRef = useRef(contexts)
  const registryRef = useRef(registry)
  const persistTimersRef = useRef(new Map<string, number>())
  const uiWriteGenerationRef = useRef(new Map<string, number>())
  const eventBufferRef = useRef(new Map<string, AgentEvent[]>())
  const approvalBufferRef = useRef(new Map<string, ToolApprovalRequest[]>())
  const questionBufferRef = useRef(new Map<string, AgentQuestionRequest[]>())
  const switchReqIdRef = useRef(0)
  const runIdToWorkspaceRef = useRef(new Map<string, string>())
  /** Runs whose controller/routing was disposed; drop late events until reopened. */
  const forgottenRunIdsRef = useRef(new Set<string>())
  const controllerLruRef = useRef<string[]>([])
  const backgroundRunIdsRef = useRef(new Set<string>())
  const refreshRunsRef = useRef<(path: string) => Promise<void>>(async () => {})
  const lastActiveRunsWarnAtRef = useRef(0)
  const activeRunsRef = useRef<{ runId: string; workspacePath: string }[]>([])
  const orphanSyncTimersRef = useRef(new Map<string, number>())

  const bump = useCallback(() => setRevision((r) => r + 1), [])

  useEffect(() => {
    registryRef.current = registry
  }, [registry])

  useEffect(() => {
    ensureChatUiPerfDump()
  }, [])

  /** True when this run's transcript is the mounted chat surface. */
  const isRunUiVisible = useCallback((runId: string): boolean => {
    if (backgroundRunIdsRef.current.has(runId)) return false
    const ws = runIdToWorkspaceRef.current.get(runId)
    if (!ws) return false
    const activePath = registryRef.current?.activePath
    if (!activePath || !workspacePathsEqual(ws, activePath)) return false
    const ctx = findByWorkspacePath(contextsRef.current, ws)
    if (!ctx) return false
    if (ctx.activeRunId === runId) return true
    // Draft composer (activeRunId null): accept events for a new/pending run on this
    // workspace so the chatStart → first-event race is not suspended.
    if (ctx.activeRunId == null) return true
    return false
  }, [])

  const applyUiSuspendForController = useCallback(
    (runId: string, ctrl: ChatStreamController): void => {
      if (isRunUiVisible(runId)) {
        void ctrl.resumeUiIfNeeded()
      } else {
        ctrl.setUiSuspended(true)
      }
    },
    [isRunUiVisible]
  )

  const suspendAllExcept = useCallback((visibleRunId: string | null): void => {
    for (const [key, ctrl] of controllersRef.current.entries()) {
      if (key.startsWith('__draft__:')) continue
      const id = ctrl.runId ?? (key.startsWith('__draft__:') ? null : key)
      if (!id || id === visibleRunId) continue
      ctrl.setUiSuspended(true)
    }
  }, [])

  useEffect(() => {
    const merged: Record<string, WorkspaceContext> = { ...contexts }
    for (const path of Object.keys(contextsRef.current)) {
      const refCtx = contextsRef.current[path]
      const stateCtx = merged[path]
      if (!refCtx) continue
      if (!stateCtx) {
        merged[path] = refCtx
        continue
      }
      const refScroll = refCtx.ui.scrollTopByRunId
      const stateScroll = stateCtx.ui.scrollTopByRunId
      const scrollChanged =
        refCtx.ui.scrollTop !== stateCtx.ui.scrollTop ||
        Object.keys(refScroll).some((key) => refScroll[key] !== stateScroll[key])
      // Prefer ref for keystroke-hot fields so draft/query isolation is not wiped
      // when React state lags behind contextsRef.
      merged[path] = {
        ...stateCtx,
        sessionQuery: refCtx.sessionQuery,
        ui: {
          ...stateCtx.ui,
          composerDraft: refCtx.ui.composerDraft,
          scrollTop: scrollChanged ? refCtx.ui.scrollTop : stateCtx.ui.scrollTop,
          scrollTopByRunId: scrollChanged
            ? { ...stateScroll, ...refScroll }
            : stateCtx.ui.scrollTopByRunId
        }
      }
    }
    contextsRef.current = merged
  }, [contexts])

  const schedulePersistUiState = useCallback((path: string, snapshot?: WorkspaceContext) => {
    const existing = persistTimersRef.current.get(path)
    if (existing) window.clearTimeout(existing)
    const timerId = window.setTimeout(() => {
      persistTimersRef.current.delete(path)
      const ctx = snapshot ?? contextsRef.current[path]
      if (!ctx || !window.vyotiq?.updateWorkspaceUiState) return
      const gen = (uiWriteGenerationRef.current.get(path) ?? 0) + 1
      uiWriteGenerationRef.current.set(path, gen)
      void window.vyotiq
        .updateWorkspaceUiState(path, { ...uiStateFromContext(ctx), writeGeneration: gen })
        .then((res) => {
          if (!res.ok) {
            logger.warn('updateWorkspaceUiState failed', {
              scope: 'workspaces',
              path,
              err: toLogErr(res.error)
            })
          }
        })
    }, UI_PERSIST_DEBOUNCE_MS)
    persistTimersRef.current.set(path, timerId)
  }, [])

  const flushPersistUiState = useCallback((path?: string) => {
    if (path) {
      const timer = persistTimersRef.current.get(path)
      if (timer) {
        window.clearTimeout(timer)
        persistTimersRef.current.delete(path)
      }
    } else {
      for (const timer of persistTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      persistTimersRef.current.clear()
    }
    const paths = path ? [path] : Object.keys(contextsRef.current)
    for (const workspacePath of paths) {
      const ctx = contextsRef.current[workspacePath]
      if (!ctx) continue
      const gen = (uiWriteGenerationRef.current.get(workspacePath) ?? 0) + 1
      uiWriteGenerationRef.current.set(workspacePath, gen)
      const ui = { ...uiStateFromContext(ctx), writeGeneration: gen }
      const api = window.vyotiq
      if (!api) continue
      const sync = (
        api as typeof api & {
          updateWorkspaceUiStateSync?: (p: string, u: WorkspaceUiState) => void
        }
      ).updateWorkspaceUiStateSync
      if (sync) {
        sync(workspacePath, ui)
      } else {
        void api.updateWorkspaceUiState?.(workspacePath, ui)
      }
    }
  }, [])

  const flushBufferedEvents = useCallback(
    (runId: string, ctrl: ChatStreamController) => {
      const buffered = eventBufferRef.current.get(runId)
      if (!buffered?.length) return
      eventBufferRef.current.delete(runId)
      for (const event of buffered) ctrl.handleEvent(event)
    },
    []
  )

  const flushBufferedApprovals = useCallback(
    (runId: string, ctrl: ChatStreamController) => {
      const buffered = approvalBufferRef.current.get(runId)
      if (!buffered?.length) return
      approvalBufferRef.current.delete(runId)
      for (const request of buffered) ctrl.handleApprovalRequest(request)
    },
    []
  )

  const flushBufferedQuestions = useCallback(
    (runId: string, ctrl: ChatStreamController) => {
      const buffered = questionBufferRef.current.get(runId)
      if (!buffered?.length) return
      questionBufferRef.current.delete(runId)
      for (const request of buffered) ctrl.handleQuestionRequest(request)
    },
    []
  )

  const bufferOrphanEvent = useCallback((runId: string, event: AgentEvent): void => {
    if (forgottenRunIdsRef.current.has(runId)) return
    const buffered = eventBufferRef.current.get(runId) ?? []
    if (buffered.length >= ORPHAN_EVENT_BUFFER_MAX) {
      if (coalesceOldestOrphanDelta(buffered)) {
        // Folded older stream delta into a later one.
      } else if (coalesceOldestOrphanToolCallDelta(buffered)) {
        // Folded older tool_call_delta into a later same-id delta.
      } else if (coalesceOldestOrphanUsage(buffered)) {
        // Dropped an older usage event; a newer same-type meter remains.
      } else {
        // Prefer freeing stream deltas, then usage meters, over tool/status chrome.
        const deltaIdx = buffered.findIndex((ev) => ORPHAN_DELTA_TYPES.has(ev.type))
        if (deltaIdx >= 0) buffered.splice(deltaIdx, 1)
        else {
          const usageIdx = buffered.findIndex((ev) => ORPHAN_USAGE_TYPES.has(ev.type))
          if (usageIdx >= 0) buffered.splice(usageIdx, 1)
          else {
            const nonCriticalIdx = buffered.findIndex((ev) => !ORPHAN_CRITICAL_TYPES.has(ev.type))
            if (nonCriticalIdx >= 0) buffered.splice(nonCriticalIdx, 1)
            else if (!ORPHAN_CRITICAL_TYPES.has(event.type)) {
              // Buffer is all critical — drop the incoming non-critical instead.
              return
            } else {
              buffered.shift()
            }
          }
        }
      }
    }
    buffered.push(event)
    eventBufferRef.current.set(runId, buffered)
  }, [])

  const bufferOrphanApproval = useCallback((runId: string, request: ToolApprovalRequest): void => {
    if (forgottenRunIdsRef.current.has(runId)) return
    const buffered = approvalBufferRef.current.get(runId) ?? []
    if (buffered.length >= ORPHAN_APPROVAL_BUFFER_MAX) {
      buffered.shift()
    }
    buffered.push(request)
    approvalBufferRef.current.set(runId, buffered)
  }, [])

  const bufferOrphanQuestion = useCallback((runId: string, request: AgentQuestionRequest): void => {
    if (forgottenRunIdsRef.current.has(runId)) return
    const buffered = questionBufferRef.current.get(runId) ?? []
    if (buffered.length >= ORPHAN_QUESTION_BUFFER_MAX) {
      buffered.shift()
    }
    buffered.push(request)
    questionBufferRef.current.set(runId, buffered)
  }, [])

  const forgetRunRouting = useCallback((runId: string): void => {
    forgottenRunIdsRef.current.add(runId)
    eventBufferRef.current.delete(runId)
    approvalBufferRef.current.delete(runId)
    questionBufferRef.current.delete(runId)
    runIdToWorkspaceRef.current.delete(runId)
    controllersRef.current.get(runId)?.dispose()
    controllersRef.current.delete(runId)
    const lruIdx = controllerLruRef.current.indexOf(runId)
    if (lruIdx >= 0) controllerLruRef.current.splice(lruIdx, 1)
  }, [])

  const touchLru = useCallback((runId: string) => {
    const lru = controllerLruRef.current
    const idx = lru.indexOf(runId)
    if (idx >= 0) lru.splice(idx, 1)
    lru.push(runId)
  }, [])

  const registerRunId = useCallback(
    (runId: string, workspacePath: string) => {
      forgottenRunIdsRef.current.delete(runId)
      runIdToWorkspaceRef.current.set(runId, workspacePath)
      touchLru(runId)
      const ctrl = controllersRef.current.get(runId)
      if (ctrl) {
        flushBufferedEvents(runId, ctrl)
        flushBufferedApprovals(runId, ctrl)
        flushBufferedQuestions(runId, ctrl)
      }
    },
    [flushBufferedApprovals, flushBufferedEvents, flushBufferedQuestions, touchLru]
  )

  const maybeEvictControllers = useCallback(
    (workspacePath: string, openRunIds: string[], activeRunId: string | null) => {
      if (openRunIds.length <= OPEN_RUN_TAB_LIMIT) return
      const excess = openRunIds.length - OPEN_RUN_TAB_LIMIT
      const candidates = controllerLruRef.current.filter((runId) => {
        if (!openRunIds.includes(runId)) return false
        if (runId === activeRunId) return false
        const ctrl = controllersRef.current.get(runId)
        if (!ctrl) return false
        if (ctrl.running || ctrl.pendingRun) return false
        return true
      })
      for (let i = 0; i < excess && i < candidates.length; i++) {
        forgetRunRouting(candidates[i]!)
      }
    },
    [forgetRunRouting]
  )

  const ensureController = useCallback(
    (workspacePath: string, runId: string | null): ChatStreamController => {
      const key = runId ?? draftControllerKey(workspacePath)
      const existing = controllersRef.current.get(key)
      if (existing) return existing

      const onRunIdAssigned = (assignedId: string): void => {
        const draftKey = draftControllerKey(workspacePath)
        const current = controllersRef.current.get(key)
        if (current && key !== assignedId) {
          const existingAssigned = controllersRef.current.get(assignedId)
          if (!existingAssigned || existingAssigned === current) {
            controllersRef.current.set(assignedId, current)
            if (controllersRef.current.get(key) === current) {
              controllersRef.current.delete(key)
            }
            touchLru(assignedId)
          } else if (key === draftKey && controllersRef.current.get(key) === current) {
            controllersRef.current.delete(key)
          }
        }
        registerRunId(assignedId, workspacePath)
        const ctx = contextsRef.current[workspacePath]
        if (!ctx) {
          void refreshRunsRef.current(workspacePath)
          return
        }
        if (ctx.activeRunId === assignedId) {
          void refreshRunsRef.current(workspacePath)
          return
        }

        let openRunIds: string[]
        if (
          ctx.activeRunId &&
          ctx.activeRunId !== assignedId &&
          ctx.openRunIds.includes(ctx.activeRunId)
        ) {
          openRunIds = ctx.openRunIds.map((id) => (id === ctx.activeRunId ? assignedId : id))
          if (!openRunIds.includes(assignedId)) {
            openRunIds = [...openRunIds, assignedId]
          }
        } else if (ctx.openRunIds.includes(assignedId)) {
          openRunIds = ctx.openRunIds
        } else {
          openRunIds = [...ctx.openRunIds, assignedId]
        }

        maybeEvictControllers(workspacePath, openRunIds, assignedId)
        const nextCtx: WorkspaceContext = {
          ...ctx,
          activeRunId: assignedId,
          openRunIds
        }
        contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
        setContexts((prev) => ({
          ...prev,
          [workspacePath]: nextCtx
        }))
        schedulePersistUiState(workspacePath, nextCtx)
        void refreshRunsRef.current(workspacePath)
      }

      const onTerminal = (): void => {
        void refreshRunsRef.current(workspacePath)
      }

      const controller = createChatStreamController({
        workspacePath,
        runId,
        onRunIdAssigned,
        onTerminal,
        getAgentMode: () => contextsRef.current[workspacePath]?.ui.agentMode ?? 'agent',
        onAgentModeChange: (mode) => {
          const ctx = contextsRef.current[workspacePath]
          if (!ctx || ctx.ui.agentMode === mode) return
          const nextCtx: WorkspaceContext = {
            ...ctx,
            ui: { ...ctx.ui, agentMode: mode }
          }
          contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
          setContexts((prev) => ({ ...prev, [workspacePath]: nextCtx }))
          schedulePersistUiState(workspacePath, nextCtx)
        }
      })
      controllersRef.current.set(key, controller)
      if (runId) {
        registerRunId(runId, workspacePath)
        void restorePendingQuestions(controller, runId)
        void restorePendingApprovals(controller, runId)
      }
      return controller
    },
    [bump, maybeEvictControllers, registerRunId, schedulePersistUiState, touchLru]
  )

  const refreshRuns = useCallback(
    async (workspacePath: string): Promise<void> => {
      if (!workspacePath.trim()) return
      if (!window.vyotiq?.listRuns) return
      const res = await window.vyotiq.listRuns(workspacePath)
      setContexts((prev) => {
        const ctx = prev[workspacePath]
        if (!ctx) return prev
        if (res.ok) {
          const runIds = res.data.runs.map((r) => r.runId)
          const reconciled = reconcileOpenRunIds(
            ctx.openRunIds,
            ctx.activeRunId,
            runIds,
            ctx.runs.map((r) => r.runId)
          )
          const nextCtx: WorkspaceContext = {
            ...ctx,
            runs: res.data.runs,
            runsCapped: res.data.capped,
            runsError: null,
            runsLoaded: true,
            ...(reconciled.changed
              ? {
                  openRunIds: reconciled.openRunIds,
                  activeRunId: reconciled.activeRunId,
                  ui: {
                    ...ctx.ui,
                    scrollTopByRunId: pruneScrollTopByRunId(ctx.ui.scrollTopByRunId, {
                      openRunIds: reconciled.openRunIds,
                      activeRunId: reconciled.activeRunId
                    })
                  }
                }
              : {})
          }
          if (reconciled.changed) {
            contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
            schedulePersistUiState(workspacePath, nextCtx)
          }
          return {
            ...prev,
            [workspacePath]: nextCtx
          }
        }
        logger.warn('listRuns failed', { scope: 'runs', err: toLogErr(res.error) })
        return {
          ...prev,
          [workspacePath]: {
            ...ctx,
            runs: [],
            runsCapped: false,
            runsError: res.error,
            runsLoaded: true
          }
        }
      })
      bump()
    },
    [bump, schedulePersistUiState]
  )

  refreshRunsRef.current = refreshRuns

  const loadRunTranscript = useCallback(
    async (
      workspacePath: string,
      runId: string,
      opts?: { isCurrent?: () => boolean }
    ): Promise<void> => {
      const ctrl = ensureController(workspacePath, runId)
      if (ctrl.running || ctrl.pendingRun) return
      if (!window.vyotiq?.loadRun) return
      const stillCurrent = (): boolean => {
        if (opts?.isCurrent && !opts.isCurrent()) return false
        if (ctrl.disposed) return false
        return controllersRef.current.get(runId) === ctrl
      }
      ctrl.setTranscriptLoading(true)
      try {
        const res = await window.vyotiq.loadRun(workspacePath, runId)
        if (!stillCurrent()) return
        if (!res.ok) {
          logger.warn('loadRun failed on restore', {
            scope: 'runs',
            correlationId: runId,
            err: res.error
          })
          setContexts((prev) => {
            const ctx = prev[workspacePath]
            if (!ctx) return prev
            return {
              ...prev,
              [workspacePath]: { ...ctx, runsError: res.error }
            }
          })
          bump()
          return
        }
        let events: PersistedEvent[] = []
        if (window.vyotiq.loadRunEvents) {
          const eventsRes = await window.vyotiq.loadRunEvents(workspacePath, runId)
          if (!stillCurrent()) return
          if (eventsRes.ok) {
            events = eventsRes.data
          } else {
            logger.warn('loadRunEvents failed on restore', {
              scope: 'runs',
              correlationId: runId,
              err: eventsRes.error
            })
            setContexts((prev) => {
              const ctx = prev[workspacePath]
              if (!ctx) return prev
              return {
                ...prev,
                [workspacePath]: { ...ctx, runsError: eventsRes.error }
              }
            })
            bump()
          }
        }
        if (!stillCurrent()) return
        ctrl.hydrateTranscript(res.data.messages, events)
        bump()
      } finally {
        if (stillCurrent()) ctrl.setTranscriptLoading(false)
      }
    },
    [bump, ensureController]
  )

  const loadRunIntoTab = useCallback(
    async (workspacePath: string, runId: string): Promise<void> => {
      await loadRunTranscript(workspacePath, runId)
    },
    [loadRunTranscript]
  )

  const reattachActiveRuns = useCallback(
    async (entries: { runId: string; workspacePath: string }[]): Promise<void> => {
      let didReattach = false
      for (const entry of entries) {
        runIdToWorkspaceRef.current.set(entry.runId, entry.workspacePath)
        const ctrl = ensureController(entry.workspacePath, entry.runId)
        if (!ctrl.running) {
          await ctrl.reattachActiveRun(entry.runId)
          didReattach = true
        }
        await restorePendingQuestions(ctrl, entry.runId)
        await restorePendingApprovals(ctrl, entry.runId)
        applyUiSuspendForController(entry.runId, ctrl)
      }
      if (didReattach) bump()
    },
    [applyUiSuspendForController, bump, ensureController]
  )

  const pollActiveRuns = useCallback(async (): Promise<void> => {
    if (!window.vyotiq?.listActiveRuns) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const res = await window.vyotiq.listActiveRuns()
    if (!res.ok) {
      const now = Date.now()
      if (now - lastActiveRunsWarnAtRef.current >= ACTIVE_RUNS_WARN_INTERVAL_MS) {
        lastActiveRunsWarnAtRef.current = now
        logger.warn('listActiveRuns failed', { scope: 'runs', err: toLogErr(res.error) })
      }
      return
    }
    const prevActive = activeRunsRef.current
    const nextActive = res.data
    const activeChanged =
      prevActive.length !== nextActive.length ||
      prevActive.some(
        (entry, i) =>
          entry.runId !== nextActive[i]?.runId ||
          !workspacePathsEqual(entry.workspacePath, nextActive[i]!.workspacePath)
      )
    activeRunsRef.current = nextActive
    if (activeChanged) {
      setActiveRuns(nextActive)
    }
    for (const entry of prevActive) {
      if (
        nextActive.some(
          (r) => r.runId === entry.runId && workspacePathsEqual(r.workspacePath, entry.workspacePath)
        )
      ) {
        continue
      }
      void refreshRunsRef.current(entry.workspacePath)
    }
    const activeIds = new Set(nextActive.map((entry) => entry.runId))
    await reattachActiveRuns(nextActive)
    for (const [key, ctrl] of controllersRef.current.entries()) {
      const id = ctrl.runId
      if (!id) continue
      if (activeIds.has(id)) {
        const pending = orphanSyncTimersRef.current.get(key)
        if (pending) {
          window.clearTimeout(pending)
          orphanSyncTimersRef.current.delete(key)
        }
        continue
      }
      if (!ctrl.running && !ctrl.pendingRun) {
        const pending = orphanSyncTimersRef.current.get(key)
        if (pending) {
          window.clearTimeout(pending)
          orphanSyncTimersRef.current.delete(key)
        }
        continue
      }
      if (orphanSyncTimersRef.current.has(key)) continue
      const timerId = window.setTimeout(() => {
        orphanSyncTimersRef.current.delete(key)
        if (typeof window === 'undefined') return
        const current = controllersRef.current.get(key)
        if (!current?.runId || current.runId !== id) return
        if (!current.running && !current.pendingRun) return
        void (async () => {
          if (window.vyotiq?.listActiveRuns) {
            const fresh = await window.vyotiq.listActiveRuns()
            if (fresh.ok && fresh.data.some((entry) => entry.runId === id)) return
          }
          await current.syncFromDisk(id)
          bump()
        })()
      }, ORPHAN_SYNC_DEBOUNCE_MS)
      orphanSyncTimersRef.current.set(key, timerId)
    }
    if (activeChanged) bump()
  }, [reattachActiveRuns, bump])

  const applyRegistry = useCallback((state: WorkspacesState) => {
    setRegistry(state)
    setContexts((prev) => {
      const next: Record<string, WorkspaceContext> = {}
      for (const path of state.openPaths) {
        const existing = prev[path]
        if (existing) {
          const ui = state.uiStateByPath[path] ?? defaultUiState()
          const refUi = contextsRef.current[path]?.ui
          const scrollTopByRunId = { ...(ui.scrollTopByRunId ?? {}) }
          if (ui.scrollTop > 0 && ui.activeRunId && scrollTopByRunId[ui.activeRunId] === undefined) {
            scrollTopByRunId[ui.activeRunId] = ui.scrollTop
          }
          const composerDraft =
            existing.ui.composerDraft !== ''
              ? existing.ui.composerDraft
              : (refUi?.composerDraft || ui.composerDraft)
          next[path] = {
            ...existing,
            activeRunId: existing.activeRunId ?? ui.activeRunId,
            openRunIds:
              existing.openRunIds.length > 0 ? existing.openRunIds : [...ui.openRunIds],
            ui: {
              scrollTop: refUi?.scrollTop ?? existing.ui.scrollTop ?? ui.scrollTop,
              scrollTopByRunId: {
                ...scrollTopByRunId,
                ...existing.ui.scrollTopByRunId,
                ...(refUi?.scrollTopByRunId ?? {})
              },
              composerDraft,
              agentMode: existing.ui.agentMode ?? refUi?.agentMode ?? ui.agentMode ?? 'agent'
            },
            settingsOverride: findSettingsOverride(state.settingsOverridesByPath, path)
          }
        } else {
          next[path] = contextFromRegistry(path, state)
        }
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!registry) return
    const open = new Set(registry.openPaths)
    for (const path of open) {
      const ctx = contextsRef.current[path] ?? contexts[path]
      if (!ctx) continue
      if (!hasWorkspaceHotUi(path)) {
        seedWorkspaceHotUi(path, {
          composerDraft: ctx.ui.composerDraft,
          sessionQuery: ctx.sessionQuery
        })
      } else {
        // Keep store draft in sync when registry restores a non-empty draft onto an empty store path.
        const hot = getWorkspaceHotUi(path)
        if (hot.composerDraft === '' && ctx.ui.composerDraft !== '') {
          seedWorkspaceHotUi(path, {
            composerDraft: ctx.ui.composerDraft,
            sessionQuery: hot.sessionQuery || ctx.sessionQuery
          })
        }
      }
    }
    for (const path of Object.keys(contexts)) {
      if (!open.has(path)) clearWorkspaceHotUi(path)
    }
  }, [registry, contexts])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      if (!window.vyotiq?.getWorkspaces) return
      const res = await window.vyotiq.getWorkspaces()
      if (cancelled) return
      if (!res.ok) {
        logger.error('getWorkspaces failed', { scope: 'workspaces', err: toLogErr(res.error) })
        setWorkspaceError(res.error)
        return
      }
      applyRegistry(res.data)
      for (const path of res.data.openPaths.filter((p) => p.trim())) {
        if (cancelled) return
        const ui = res.data.uiStateByPath[path] ?? defaultUiState()
        for (const runId of ui.openRunIds) {
          ensureController(path, runId)
        }
        if (ui.activeRunId) {
          await loadRunTranscript(path, ui.activeRunId, {
            isCurrent: () => !cancelled
          })
        }
        if (cancelled) return
        void refreshRuns(path)
      }
      if (cancelled) return
      if (window.vyotiq.listActiveRuns) {
        const activeRes = await window.vyotiq.listActiveRuns()
        if (cancelled) return
        if (activeRes.ok) {
          setActiveRuns(activeRes.data)
          await reattachActiveRuns(activeRes.data)
        }
      }
      if (cancelled) return
      if (res.data.activePath) {
        const ui = res.data.uiStateByPath[res.data.activePath] ?? defaultUiState()
        const key = scrollKeyForRun(ui.activeRunId)
        const restoreTop = ui.scrollTopByRunId?.[key] ?? ui.scrollTop
        if (restoreTop > 0) {
          setScrollRestoreToken((t) => t + 1)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [applyRegistry, ensureController, loadRunTranscript, refreshRuns, reattachActiveRuns])

  useEffect(() => {
    const onBeforeUnload = (): void => {
      flushPersistUiState()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [flushPersistUiState])

  useEffect(() => {
    if (!window.vyotiq?.onChatEvent) return
    return window.vyotiq.onChatEvent((event) => {
      const workspacePath = runIdToWorkspaceRef.current.get(event.runId)
      let ctrl = controllersRef.current.get(event.runId)
      if (!ctrl && workspacePath) {
        ctrl = ensureController(workspacePath, event.runId)
      }
      if (!ctrl) {
        bufferOrphanEvent(event.runId, event)
        return
      }
      if (!isRunUiVisible(event.runId)) {
        ctrl.setUiSuspended(true)
      }
      ctrl.handleEvent(event)
    })
  }, [bufferOrphanEvent, ensureController, isRunUiVisible])

  useEffect(() => {
    if (!window.vyotiq?.onToolApprovalRequest) return
    return window.vyotiq.onToolApprovalRequest((request) => {
      const workspacePath = runIdToWorkspaceRef.current.get(request.runId)
      const ctrl =
        controllersRef.current.get(request.runId) ??
        (workspacePath ? ensureController(workspacePath, request.runId) : undefined)
      if (!ctrl) {
        bufferOrphanApproval(request.runId, request)
        return
      }
      ctrl.handleApprovalRequest(request)
    })
  }, [bufferOrphanApproval, ensureController])

  useEffect(() => {
    if (!window.vyotiq?.onAgentQuestionRequest) return
    return window.vyotiq.onAgentQuestionRequest((request) => {
      const workspacePath = runIdToWorkspaceRef.current.get(request.runId)
      const ctrl =
        controllersRef.current.get(request.runId) ??
        (workspacePath ? ensureController(workspacePath, request.runId) : undefined)
      if (!ctrl) {
        bufferOrphanQuestion(request.runId, request)
        return
      }
      ctrl.handleQuestionRequest(request)
    })
  }, [bufferOrphanQuestion, ensureController])

  useEffect(() => {
    void pollActiveRuns()
    const id = window.setInterval(() => void pollActiveRuns(), ACTIVE_RUNS_POLL_MS)
    const onFocus = (): void => {
      void pollActiveRuns()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void pollActiveRuns()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      for (const timer of orphanSyncTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      orphanSyncTimersRef.current.clear()
    }
  }, [pollActiveRuns])

  const activeWorkspace = registry?.activePath ?? null
  const openWorkspaces = registry?.openPaths ?? []
  const activeContext = activeWorkspace
    ? findByWorkspacePath(contexts, activeWorkspace)
    : null

  const switchWorkspace = useCallback(
    async (path: string): Promise<void> => {
      if (!window.vyotiq?.setActiveWorkspace) return
      if (activeWorkspace) flushPersistUiState(activeWorkspace)
      const reqId = ++switchReqIdRef.current
      const res = await window.vyotiq.setActiveWorkspace(path)
      if (reqId !== switchReqIdRef.current) return
      if (res.ok) {
        setWorkspaceError(null)
        applyRegistry(res.data)
        const ctx = contextsRef.current[path]
        const visibleRunId = ctx?.activeRunId ?? null
        suspendAllExcept(visibleRunId)
        if (visibleRunId) {
          backgroundRunIdsRef.current.delete(visibleRunId)
          const ctrl = ensureController(path, visibleRunId)
          void ctrl.resumeUiIfNeeded()
        }
        setChatSurfaceEpoch((t) => t + 1)
        setScrollRestoreToken((t) => t + 1)
      } else {
        setWorkspaceError(res.error)
      }
    },
    [activeWorkspace, applyRegistry, ensureController, flushPersistUiState, suspendAllExcept]
  )

  const addWorkspace = useCallback(
    async (path?: string): Promise<void> => {
      if (!window.vyotiq?.addWorkspace) return
      const res = await window.vyotiq.addWorkspace(path)
      if (res.ok) {
        setWorkspaceError(null)
        applyRegistry(res.data)
        for (const p of res.data.openPaths) {
          setContexts((prev) => {
            if (prev[p]) return prev
            return { ...prev, [p]: contextFromRegistry(p, res.data) }
          })
          void refreshRuns(p)
        }
      } else {
        setWorkspaceError(res.error)
      }
    },
    [applyRegistry, refreshRuns]
  )

  const removeWorkspace = useCallback(
    async (path: string): Promise<void> => {
      const activeForWorkspace = activeRunsRef.current.filter((run) =>
        workspacePathsEqual(run.workspacePath, path)
      )
      if (
        activeForWorkspace.length > 0 &&
        !window.confirm(
          `This workspace has ${activeForWorkspace.length} active run(s). Stop ${
            activeForWorkspace.length === 1 ? 'it' : 'them'
          } and close the workspace?`
        )
      ) {
        return
      }

      flushPersistUiState(path)

      if (!window.vyotiq?.removeWorkspace) return
      const res = await window.vyotiq.removeWorkspace(path, activeForWorkspace.length > 0)
      if (res.ok) {
        for (const run of activeForWorkspace) {
          backgroundRunIdsRef.current.delete(run.runId)
          forgetRunRouting(run.runId)
        }
        setWorkspaceError(null)
        applyRegistry(res.data)
        setContexts((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
      } else {
        setWorkspaceError(res.error)
      }
    },
    [applyRegistry, flushPersistUiState, forgetRunRouting]
  )

  const getRunController = useCallback(
    (runId: string | null): ChatStreamController | null => {
      if (!activeWorkspace) return null
      return ensureController(activeWorkspace, runId)
    },
    [activeWorkspace, ensureController]
  )

  const openRunTabInWorkspace = useCallback(
    (workspacePath: string, runId: string | null): void => {
      const entryKey =
        contextsRef.current[workspacePath] !== undefined
          ? workspacePath
          : (Object.keys(contextsRef.current).find((k) =>
              workspacePathsEqual(k, workspacePath)
            ) ?? workspacePath)
      const ctx = contextsRef.current[entryKey] ?? findByWorkspacePath(contextsRef.current, workspacePath)
      if (!ctx) return
      const sameTab = ctx.activeRunId === runId
      const openRunIds =
        runId && !ctx.openRunIds.includes(runId) ? [...ctx.openRunIds, runId] : ctx.openRunIds
      const nextCtx = {
        ...ctx,
        activeRunId: runId,
        openRunIds
      }
      maybeEvictControllers(entryKey, openRunIds, runId)
      if (runId) backgroundRunIdsRef.current.delete(runId)
      const ctrl = ensureController(entryKey, runId)
      contextsRef.current = { ...contextsRef.current, [entryKey]: nextCtx }
      setContexts((prev) => ({
        ...prev,
        [entryKey]: nextCtx
      }))
      schedulePersistUiState(entryKey, nextCtx)
      suspendAllExcept(runId)
      if (runId) {
        void ctrl.resumeUiIfNeeded()
      }
      if (!sameTab) {
        flushPersistUiState(entryKey)
        setChatSurfaceEpoch((t) => t + 1)
        setScrollRestoreToken((t) => t + 1)
      }
      bump()
    },
    [
      bump,
      ensureController,
      flushPersistUiState,
      maybeEvictControllers,
      schedulePersistUiState,
      suspendAllExcept
    ]
  )

  const openRunTab = useCallback(
    (runId: string | null): void => {
      if (!activeWorkspace) return
      openRunTabInWorkspace(activeWorkspace, runId)
    },
    [activeWorkspace, openRunTabInWorkspace]
  )

  const openRunInWorkspace = useCallback(
    async (path: string, runId: string): Promise<void> => {
      if (!activeWorkspace || !workspacePathsEqual(activeWorkspace, path)) {
        await switchWorkspace(path)
      }
      openRunTabInWorkspace(path, runId)
    },
    [activeWorkspace, openRunTabInWorkspace, switchWorkspace]
  )

  const closeRunTab = useCallback(
    (runId: string): void => {
      if (!activeWorkspace) return
      const ctx = contextsRef.current[activeWorkspace]
      if (!ctx) return
      const ctrl = controllersRef.current.get(runId)
      if (ctrl?.running || ctrl?.pendingRun) {
        backgroundRunIdsRef.current.add(runId)
        ctrl.setUiSuspended(true)
      } else {
        forgetRunRouting(runId)
      }
      const openRunIds = ctx.openRunIds.filter((id) => id !== runId)
      const activeRunId =
        ctx.activeRunId === runId ? openRunIds[openRunIds.length - 1] ?? null : ctx.activeRunId
      const nextCtx = { ...ctx, openRunIds, activeRunId }
      contextsRef.current = { ...contextsRef.current, [activeWorkspace]: nextCtx }
      setContexts((prev) => ({
        ...prev,
        [activeWorkspace]: nextCtx
      }))
      schedulePersistUiState(activeWorkspace, nextCtx)
      if (activeRunId) {
        const nextCtrl = controllersRef.current.get(activeRunId)
        if (nextCtrl) void nextCtrl.resumeUiIfNeeded()
      }
      if (ctx.activeRunId === runId) {
        setChatSurfaceEpoch((t) => t + 1)
        setScrollRestoreToken((t) => t + 1)
      }
      bump()
    },
    [activeWorkspace, bump, forgetRunRouting, schedulePersistUiState]
  )

  const purgeDeletedRunUi = useCallback(
    (workspacePath: string, runId: string): void => {
      const ctx = contextsRef.current[workspacePath]
      if (!ctx) return
      const scrollTopByRunId = omitRunScrollTop(ctx.ui.scrollTopByRunId, runId)
      if (scrollTopByRunId === ctx.ui.scrollTopByRunId) return
      const nextCtx: WorkspaceContext = {
        ...ctx,
        ui: { ...ctx.ui, scrollTopByRunId }
      }
      contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
      setContexts((prev) => ({ ...prev, [workspacePath]: nextCtx }))
      schedulePersistUiState(workspacePath, nextCtx)
    },
    [schedulePersistUiState]
  )

  const setComposerDraft = useCallback(
    (draft: string) => {
      if (!activeWorkspace) return
      const ctx = contextsRef.current[activeWorkspace]
      if (!ctx) return
      if (ctx.ui.composerDraft === draft) return
      const nextCtx: WorkspaceContext = {
        ...ctx,
        ui: { ...ctx.ui, composerDraft: draft }
      }
      contextsRef.current = {
        ...contextsRef.current,
        [activeWorkspace]: nextCtx
      }
      setContexts((prev) => ({ ...prev, [activeWorkspace]: nextCtx }))
      setWorkspaceHotUi(activeWorkspace, { composerDraft: draft })
      schedulePersistUiState(activeWorkspace, nextCtx)
    },
    [activeWorkspace, schedulePersistUiState]
  )

  const setAgentMode = useCallback(
    (mode: AgentInteractionMode) => {
      if (!activeWorkspace) return
      const ctx = contextsRef.current[activeWorkspace]
      if (!ctx) return
      if (ctx.ui.agentMode === mode) return
      const nextCtx: WorkspaceContext = {
        ...ctx,
        ui: { ...ctx.ui, agentMode: mode }
      }
      contextsRef.current = {
        ...contextsRef.current,
        [activeWorkspace]: nextCtx
      }
      setContexts((prev) => ({ ...prev, [activeWorkspace]: nextCtx }))
      schedulePersistUiState(activeWorkspace, nextCtx)
    },
    [activeWorkspace, schedulePersistUiState]
  )

  const onMessageListScroll = useCallback(
    (scrollTop: number) => {
      if (!activeWorkspace) return
      const ctx = contextsRef.current[activeWorkspace]
      if (!ctx) return
      const key = scrollKeyForRun(ctx.activeRunId)
      if (ctx.ui.scrollTopByRunId[key] === scrollTop && ctx.ui.scrollTop === scrollTop) return
      const nextCtx: WorkspaceContext = {
        ...ctx,
        ui: {
          ...ctx.ui,
          scrollTop,
          scrollTopByRunId: { ...ctx.ui.scrollTopByRunId, [key]: scrollTop }
        }
      }
      contextsRef.current = { ...contextsRef.current, [activeWorkspace]: nextCtx }
      schedulePersistUiState(activeWorkspace, nextCtx)
    },
    [activeWorkspace, schedulePersistUiState]
  )

  const setSessionQuery = useCallback(
    (query: string): void => {
      if (!activeWorkspace) return
      const ctx = contextsRef.current[activeWorkspace]
      if (!ctx) return
      if (ctx.sessionQuery === query) return
      const nextCtx: WorkspaceContext = { ...ctx, sessionQuery: query }
      contextsRef.current = {
        ...contextsRef.current,
        [activeWorkspace]: nextCtx
      }
      setWorkspaceHotUi(activeWorkspace, { sessionQuery: query })
    },
    [activeWorkspace]
  )

  const setSettingsOverride = useCallback(
    async (
      path: string,
      override: WorkspaceSettingsOverride | null
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!window.vyotiq?.setWorkspaceSettingsOverride) {
        return { ok: false, error: 'Workspace settings API unavailable.' }
      }
      const res = await window.vyotiq.setWorkspaceSettingsOverride(path, override)
      if (!res.ok) return { ok: false, error: res.error }
      applyRegistry(res.data)
      bump()
      return { ok: true }
    },
    [applyRegistry, bump]
  )

  const activeController = activeWorkspace
    ? ensureController(activeWorkspace, activeContext?.activeRunId ?? null)
    : null

  const activeControllerRef = useRef(activeController)
  activeControllerRef.current = activeController

  const onLoadToolContent = useCallback(
    (toolCallId: string) =>
      activeControllerRef.current?.loadToolContent(toolCallId) ?? Promise.resolve(null),
    []
  )

  const onThinkingToggle = useCallback((messageId: string, expanded: boolean) => {
    activeControllerRef.current?.setThinkingExpanded(messageId, expanded)
  }, [])

  const onToolToggle = useCallback((toolCallId: string, expanded: boolean) => {
    activeControllerRef.current?.setToolExpanded(toolCallId, expanded)
  }, [])

  const onGroupToggle = useCallback((anchorToolCallId: string, expanded: boolean) => {
    activeControllerRef.current?.setGroupExpanded(anchorToolCallId, expanded)
  }, [])

  const onTurnToggle = useCallback((turnIndex: number) => {
    activeControllerRef.current?.toggleTurnCollapsed(turnIndex)
  }, [])

  const onApprovalDecision = useCallback(
    (requestId: string, decision: ToolApprovalDecision) =>
      activeControllerRef.current?.respondToApproval(requestId, decision) ?? Promise.resolve(),
    []
  )

  const onQuestionSubmit = useCallback(
    (requestId: string, answers: UiAgentQuestionAnswer[]) =>
      activeControllerRef.current?.respondToQuestion(requestId, answers) ?? Promise.resolve(),
    []
  )

  const subscribeActiveController = useCallback(
    (onStoreChange: () => void) => activeController?.subscribeMeta(onStoreChange) ?? (() => {}),
    [activeController]
  )

  const getActiveControllerRevision = useCallback(
    () => activeController?.getMetaRevision() ?? 0,
    [activeController]
  )

  useSyncExternalStore(
    subscribeActiveController,
    getActiveControllerRevision,
    getActiveControllerRevision
  )

  const chatSnapshot = activeController
    ? {
        items: activeController.items,
        messages: activeController.messages,
        running: activeController.running,
        invokeId: activeController.getInvokeId(),
        runId: activeController.runId,
        error: activeController.error,
        runNotice: activeController.runNotice,
        incomplete: activeController.incomplete,
        contextUsage: activeController.contextUsage,
        runStartedAt: activeController.runStartedAt,
        runTerminalTick: activeController.runTerminalTick,
        pendingRun: activeController.pendingRun,
        transcriptLoading: activeController.transcriptLoading,
        collapsedTurnIndices: activeController.collapsedTurnIndices,
        writeCheckpoint: activeController.writeCheckpoint,
        pendingFollowUps: activeController.pendingFollowUps,
        subscribeItems: activeController.subscribeItems.bind(activeController),
        getItemsRevision: activeController.getItemsRevision.bind(activeController),
        getItems: () => activeController.items,
        subscribeMeta: activeController.subscribeMeta.bind(activeController),
        getMetaRevision: activeController.getMetaRevision.bind(activeController),
        getContextUsage: activeController.getContextUsage.bind(activeController)
      }
    : {
        items: [] as ChatStreamController['items'],
        messages: [] as ChatStreamController['messages'],
        running: false,
        invokeId: null as number | null,
        runId: null as string | null,
        error: null as string | null,
        runNotice: null as string | null,
        incomplete: null as ChatStreamController['incomplete'],
        contextUsage: null,
        runStartedAt: null as number | null,
        runTerminalTick: 0,
        pendingRun: false,
        transcriptLoading: false,
        collapsedTurnIndices: [] as number[],
        writeCheckpoint: null as ChatStreamController['writeCheckpoint'],
        pendingFollowUps: [] as ChatStreamController['pendingFollowUps'],
        subscribeItems: (_listener: () => void) => () => {},
        getItemsRevision: () => 0,
        getItems: () => [] as ChatStreamController['items'],
        subscribeMeta: (_listener: () => void) => () => {},
        getMetaRevision: () => 0,
        getContextUsage: () => null
      }

  const collapsedTurns = useMemo(
    () =>
      chatSnapshot.collapsedTurnIndices.length > 0
        ? new Set(chatSnapshot.collapsedTurnIndices)
        : undefined,
    [chatSnapshot.collapsedTurnIndices]
  )

  void revision

  const refreshActiveRuns = useCallback(() => {
    if (activeWorkspace) void refreshRuns(activeWorkspace)
  }, [activeWorkspace, refreshRuns])

  const refreshWorkspaceRuns = useCallback(
    (workspacePath: string): void => {
      void refreshRuns(workspacePath)
    },
    [refreshRuns]
  )

  useEffect(() => {
    if (!activeWorkspace) return
    const timer = window.setTimeout(() => {
      void refreshRuns(activeWorkspace)
    }, LIST_RUNS_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [activeWorkspace, chatSnapshot.runTerminalTick, refreshRuns])

  const isRunActiveInBackground = useCallback(
    (runId: string): boolean => backgroundRunIdsRef.current.has(runId),
    []
  )

  const workspaceHasBackgroundRun = useCallback(
    (workspacePath: string): boolean => {
      return activeRuns.some(
        (r) =>
          workspacePathsEqual(r.workspacePath, workspacePath) &&
          (backgroundRunIdsRef.current.has(r.runId) ||
            !contexts[workspacePath]?.openRunIds.includes(r.runId))
      )
    },
    [activeRuns, contexts]
  )

  const clearRunsError = useCallback((workspacePath?: string) => {
    const path = workspacePath ?? activeWorkspace
    if (!path) return
    setContexts((prev) => {
      const ctx = prev[path]
      if (!ctx || !ctx.runsError) return prev
      return {
        ...prev,
        [path]: { ...ctx, runsError: null }
      }
    })
  }, [activeWorkspace])

  const clearWorkspaceError = useCallback(() => setWorkspaceError(null), [])

  const activeScrollTop = activeContext
    ? (activeContext.ui.scrollTopByRunId[scrollKeyForRun(activeContext.activeRunId)] ??
      activeContext.ui.scrollTop)
    : 0

  const chatActions = useMemo(
    () =>
      activeController
        ? {
            send: activeController.send.bind(activeController),
            editAndResend: activeController.editAndResend.bind(activeController),
            removeFollowUp: activeController.removeFollowUp.bind(activeController),
            stop: activeController.stop.bind(activeController),
            reset: activeController.reset.bind(activeController),
            loadTranscript: activeController.loadTranscript.bind(activeController),
            loadToolContent: activeController.loadToolContent.bind(activeController),
            clearError: activeController.clearError.bind(activeController),
            applyManualCompaction: activeController.applyManualCompaction.bind(activeController),
            markWriteCheckpointUndone:
              activeController.markWriteCheckpointUndone.bind(activeController),
            applyWriteCheckpointResolution:
              activeController.applyWriteCheckpointResolution.bind(activeController)
          }
        : null,
    [activeController]
  )

  return {
    registry,
    activeWorkspace,
    openWorkspaces,
    activeContext,
    contexts,
    activeController,
    activeRuns,
    chat: chatSnapshot,
    switchWorkspace,
    addWorkspace,
    removeWorkspace,
    getRunController,
    loadRunIntoTab,
    openRunTab,
    openRunInWorkspace,
    closeRunTab,
    setSessionQuery,
    refreshActiveRuns,
    refreshWorkspaceRuns,
    isRunActiveInBackground,
    workspaceHasBackgroundRun,
    scrollRestoreToken,
    chatSurfaceEpoch,
    activeScrollTop,
    workspaceError,
    clearWorkspaceError,
    clearRunsError,
    setComposerDraft,
    setAgentMode,
    onMessageListScroll,
    setSettingsOverride,
    onLoadToolContent,
    onThinkingToggle,
    onToolToggle,
    onGroupToggle,
    onTurnToggle,
    onApprovalDecision,
    onQuestionSubmit,
    collapsedTurns,
    chatActions,
    purgeDeletedRunUi
  }
}
