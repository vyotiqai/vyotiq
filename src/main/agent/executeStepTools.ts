import { existsSync } from 'fs'
import type { AgentEvent, AgentInteractionMode, ChatMessage, Settings } from '../../shared/ipc'
import { isAbortError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { summarizeToolArgs } from '../../shared/toolSummary'
import { toolResultEventForPersistence } from '../../shared/utils/toolResultIpc'
import type { ToolCall } from './providers/types'
import { executeTool } from '@main/agent/tools'
import { isParallelSafeTool, MAX_PARALLEL_READ_TOOLS } from './tools/classify'
import { repairToolArgs } from './toolArgsRepair'
import type { ToolApprovalGate } from './toolApproval'
import type { TerminalShell } from '../../shared/ipc'
import { resolveInsideWorkspace } from '../workspace/safePath'
import {
  applyToolCallToKnownPaths,
  applyToolCallToMutationPaths,
  isFileMutationToolName,
  toolArgsFromCall,
  unreadExistingEditPaths
} from './loopPolicy'
import { hasJavaScriptProject, hasTypeScriptProject } from './tools/diagnostics'
import { validateWriteToolCall } from './tools/writeGuard'
import { ensureToolCallIds } from './dedupeToolCalls'

/** Soft ADW nudge: mutations without diagnostics in the same step are not a hard gate. */
export const SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS =
  '[Soft warning: this step mutated file(s) without calling diagnostics. Run diagnostics (typecheck/lint) before treating the change as done.]'

export type ToolStepContext = {
  runId: string
  runDir: string
  workspace: string
  /** Combined run cancel + soft stream / follow-up interrupt. */
  signal: AbortSignal
  /** Run-level cancel only — distinguishes Interrupted vs Cancelled. */
  runSignal?: AbortSignal
  appendMessage: (msg: ChatMessage) => Promise<void>
  appendEvent: (ev: AgentEvent) => void
  /** Session-scoped paths already inspected or edited (read-before-edit soft warn). */
  knownPaths?: Set<string>
  /** Run-scoped paths the agent actually changed (scopes git_commit staging). */
  mutationPaths?: Set<string>
  /** Override parallel read batch size (e.g. 1 after consecutive failure steps). */
  maxParallelReadTools?: number
  /** Present only when the workspace opted into tool approval. */
  approval?: ToolApprovalGate
  /** ChatStart invoke that owns this step; scopes interactive cancel. */
  invokeId?: number
  /** Ask / Plan / Agent for this invoke (mutable via switch_mode). */
  agentMode?: AgentInteractionMode
  getAgentMode?: () => AgentInteractionMode
  setAgentMode?: (mode: AgentInteractionMode) => void | Promise<void>
  /** Snapshot of settings.autoModeSwitch for this invoke. */
  autoModeSwitch?: boolean
  /** Snapshot of settings.terminalShell for this invoke. */
  terminalShell?: TerminalShell
  /** Snapshot of settings.diagnosticsCommand for this invoke. */
  diagnosticsCommand?: string
  /** Invoke-snapshotted settings for image tools. */
  imageToolSettings?: Settings
  /** Streams events while a tool is still running (e.g. image progress). */
  emitLiveEvent?: (ev: AgentEvent) => void
  /**
   * MCP servers enabled for this run (workspace overrides applied).
   * Enforced at invoke time so Force-off cannot be bypassed via stale tool names.
   */
  runEnabledMcpIds?: ReadonlySet<string>
  /** Per-server allow/deny for bare MCP tool names. */
  mcpToolPolicies?: ReadonlyMap<string, { allowedTools?: string[]; deniedTools?: string[] }>
  /**
   * MCP tool full names in this step's provider catalog (post budget trim).
   * When set, MCP invokes outside this set are rejected.
   */
  stepMcpToolNames?: ReadonlySet<string>
  /** Run-scoped MCP tools pinned via request_mcp_tools. */
  runPinnedMcpToolNames?: Set<string>
  /** Last step each MCP tool was pinned or invoked. */
  mcpLastUsedByName?: Map<string, number>
  /** Current agent step for last-used stamps. */
  currentStep?: number
  invalidateMcpToolCatalogCache?: () => void
  /** Run-scoped MCP not-in-catalog rejection counts (per full tool name). */
  mcpNotInCatalogCounts?: Map<string, number>
}

function isMalformedToolCall(call: ToolCall): string | null {
  if (!call.name?.trim()) return 'Tool call missing name'
  if (!call.id?.trim()) return 'Tool call missing id'
  try {
    JSON.parse(call.arguments || '{}')
  } catch {
    return 'Tool call arguments are not valid JSON'
  }
  return null
}

/**
 * A truncated stream leaves structurally unfinished arguments that are still
 * usable once the punctuation is closed. Repair before validation so one lost
 * frame does not cost the model a whole tool call.
 */
function withRepairedArguments(call: ToolCall, ctx: ToolStepContext): ToolCall {
  const raw = call.arguments || '{}'
  try {
    JSON.parse(raw)
    return call
  } catch {
    const repaired = repairToolArgs(raw)
    if (!repaired) return call
    logger.warn('Repaired truncated tool call arguments', {
      scope: 'agent',
      code: 'TOOL_ARGS',
      correlationId: ctx.runId,
      tool: call.name || 'unknown'
    })
    return { ...call, arguments: repaired }
  }
}

type ToolOutcome = {
  ok: boolean
  events: AgentEvent[]
  message: ChatMessage
}

function abortToolContent(ctx: ToolStepContext): string {
  const runAborted = ctx.runSignal?.aborted ?? ctx.signal.aborted
  if (runAborted) return 'Cancelled'
  if (ctx.signal.aborted) return 'Interrupted'
  return 'Cancelled'
}

function abortToolSummary(ctx: ToolStepContext): string {
  return abortToolContent(ctx).toLowerCase()
}

function emitToolStart(ctx: ToolStepContext, event: AgentEvent): void {
  ctx.appendEvent(event)
  ctx.emitLiveEvent?.(event)
}

function emitToolResult(ctx: ToolStepContext, event: AgentEvent): void {
  if (event.type !== 'tool_result') return
  ctx.emitLiveEvent?.(event)
}

async function runSingleTool(
  rawCall: ToolCall,
  ctx: ToolStepContext,
  stepFlags?: { softDiagnosticsNudge: boolean }
): Promise<ToolOutcome> {
  const events: AgentEvent[] = []
  const call = withRepairedArguments(rawCall, ctx)
  const malformed = isMalformedToolCall(call)
  if (malformed) {
    logger.warn('Malformed tool call', {
      scope: 'agent',
      code: 'TOOL_ARGS',
      correlationId: ctx.runId,
      tool: call.name || 'unknown'
    })
    const toolMsg: ChatMessage = {
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name || 'unknown',
      content: malformed,
      ok: false
    }
    events.push(
      {
        type: 'tool_start',
        runId: ctx.runId,
        toolCallId: call.id,
        name: call.name || 'unknown',
        summary: 'invalid'
      },
      {
        type: 'tool_result',
        runId: ctx.runId,
        toolCallId: call.id,
        name: call.name || 'unknown',
        summary: 'invalid',
        ok: false,
        content: malformed
      }
    )
    emitToolStart(ctx, events[0]!)
    return { ok: false, events, message: toolMsg }
  }

  const summary = summarizeToolArgs(call.name, call.arguments)
  events.push({
    type: 'tool_start',
    runId: ctx.runId,
    toolCallId: call.id,
    name: call.name,
    summary
  })
  emitToolStart(ctx, events[0]!)

  try {
    validateWriteToolCall(call.name, call.arguments, ctx.workspace)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const toolMsg: ChatMessage = {
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      content: reason,
      ok: false
    }
    events.push({
      type: 'tool_result',
      runId: ctx.runId,
      toolCallId: call.id,
      name: call.name,
      summary: 'rejected',
      ok: false,
      content: reason
    })
    emitToolResult(ctx, events[events.length - 1]!)
    return { ok: false, events, message: toolMsg }
  }

  try {
    // Ask before doing anything: the tool_start event is already out, so the
    // renderer can show the approval card in the row the user is looking at.
    if (ctx.approval) {
      const agentMode = ctx.getAgentMode?.() ?? ctx.agentMode
      // Ask/Plan generate_image is describe-only (no network/write) — skip approval.
      const dryRunImage =
        (call.name === 'generate_image' || call.name === 'edit_image') &&
        (agentMode === 'ask' || agentMode === 'plan')
      if (!dryRunImage) {
        const verdict = await ctx.approval.authorize(call)
        if (!verdict.allowed) {
          const toolMsg: ChatMessage = {
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: verdict.reason,
            ok: false
          }
          events.push({
            type: 'tool_result',
            runId: ctx.runId,
            toolCallId: call.id,
            name: call.name,
            summary: 'denied',
            ok: false,
            content: verdict.reason
          })
          return { ok: false, events, message: toolMsg }
        }
      }
    }

    const toolArgs = toolArgsFromCall(call.arguments)
    const unreadPaths =
      ctx.knownPaths != null
        ? unreadExistingEditPaths(ctx.knownPaths, call.name, toolArgs, (rel) => {
            try {
              return existsSync(resolveInsideWorkspace(ctx.workspace, rel))
            } catch {
              return false
            }
          })
        : []

    const result = await executeTool(call.name, call.arguments, ctx.workspace, ctx.signal, {
      runDir: ctx.runDir,
      runId: ctx.runId,
      toolCallId: call.id,
      invokeId: ctx.invokeId,
      /** Hard run cancel only — soft stream interrupt stays on `signal`. */
      runSignal: ctx.runSignal,
      agentMode: ctx.getAgentMode?.() ?? ctx.agentMode,
      getAgentMode: ctx.getAgentMode,
      setAgentMode: ctx.setAgentMode,
      autoModeSwitch: ctx.autoModeSwitch,
      terminalShell: ctx.terminalShell,
      diagnosticsCommand: ctx.diagnosticsCommand,
      imageToolSettings: ctx.imageToolSettings,
      emitAgentEvent: ctx.emitLiveEvent,
      runEnabledMcpIds: ctx.runEnabledMcpIds,
      mcpToolPolicies: ctx.mcpToolPolicies,
      stepMcpToolNames: ctx.stepMcpToolNames,
      runPinnedMcpToolNames: ctx.runPinnedMcpToolNames,
      mcpLastUsedByName: ctx.mcpLastUsedByName,
      currentStep: ctx.currentStep,
      invalidateMcpToolCatalogCache: ctx.invalidateMcpToolCatalogCache,
      mcpNotInCatalogCounts: ctx.mcpNotInCatalogCounts,
      mutationPaths: ctx.mutationPaths,
      approval: ctx.approval,
      onProgress: ctx.emitLiveEvent
        ? (update) =>
            ctx.emitLiveEvent?.({
              type: 'tool_progress',
              runId: ctx.runId,
              parentToolCallId: call.id,
              kind: update.kind,
              text: update.text
            })
        : undefined,
      onTerminalOutput: ctx.emitLiveEvent
        ? (chunk) =>
            ctx.emitLiveEvent?.({
              type: 'terminal_output_delta',
              runId: ctx.runId,
              toolCallId: call.id,
              text: chunk.text,
              stream: chunk.stream
            })
        : undefined
    })
    let content = result.content
    if (result.ok && unreadPaths.length > 0) {
      content = `${content}\n\n[Soft warning: edited existing file(s) without a prior read/grep/glob inspect: ${unreadPaths.join(', ')}]`
    }
    if (
      result.ok &&
      stepFlags?.softDiagnosticsNudge &&
      isFileMutationToolName(call.name)
    ) {
      content = `${content}\n\n${SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS}`
    }
    if (ctx.knownPaths) {
      applyToolCallToKnownPaths(ctx.knownPaths, call.name, toolArgs, result.ok)
    }
    if (ctx.mutationPaths) {
      applyToolCallToMutationPaths(ctx.mutationPaths, call.name, toolArgs, result.ok)
    }
    const resultSummary = result.summary || summary
    const toolMsg: ChatMessage = {
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      content,
      ok: result.ok
    }
    events.push({
      type: 'tool_result',
      runId: ctx.runId,
      toolCallId: call.id,
      name: call.name,
      summary: resultSummary,
      ok: result.ok,
      content
    })
    if (!result.ok && !result.failureLogged) {
      logger.warn('Tool returned failure', {
        scope: 'agent',
        code: 'TOOL_EXEC',
        correlationId: ctx.runId,
        tool: call.name,
        reason: result.summary === 'error' ? undefined : result.summary,
        // Safe provider taxonomy only — never log full tool content (may include prompts).
        ...(call.name === 'generate_image' || call.name === 'edit_image'
          ? {
              kind: /401|auth|API key/i.test(result.content)
                ? 'auth'
                : /moderation/i.test(result.content)
                  ? 'moderation'
                  : 'image'
            }
          : {})
      })
    }
    return {
      ok: result.ok,
      events,
      message: toolMsg
    }
  } catch (err) {
    if (isAbortError(err)) {
      const content = abortToolContent(ctx)
      const summary = abortToolSummary(ctx)
      const toolMsg: ChatMessage = {
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content,
        ok: false
      }
      events.push({
        type: 'tool_result',
        runId: ctx.runId,
        toolCallId: call.id,
        name: call.name,
        summary,
        ok: false,
        content
      })
      return { ok: false, events, message: toolMsg }
    }
    throw err
  }
}

/** Write the settled result to disk once the repeat-failure hint has been applied. */
function persistToolResult(ctx: ToolStepContext, outcome: ToolOutcome): void {
  for (const ev of outcome.events) {
    if (ev.type === 'tool_result') ctx.appendEvent(toolResultEventForPersistence(ev))
  }
}

function abortedToolResult(
  call: ToolCall,
  ctx: ToolStepContext,
  options?: { emitStart?: boolean }
): ToolOutcome {
  const content = abortToolContent(ctx)
  const summary = abortToolSummary(ctx)
  const toolMsg: ChatMessage = {
    role: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    content,
    ok: false
  }
  const startEv: AgentEvent = {
    type: 'tool_start',
    runId: ctx.runId,
    toolCallId: call.id,
    name: call.name,
    summary: summarizeToolArgs(call.name, call.arguments)
  }
  const ev: AgentEvent = {
    type: 'tool_result',
    runId: ctx.runId,
    toolCallId: call.id,
    name: call.name,
    summary,
    ok: false,
    content
  }
  const emitStart = options?.emitStart !== false
  if (emitStart) {
    emitToolStart(ctx, startEv)
    return { ok: false, events: [startEv, ev], message: toolMsg }
  }
  return { ok: false, events: [ev], message: toolMsg }
}

async function runParallelBatch(
  calls: ToolCall[],
  ctx: ToolStepContext,
  parallelLimit: number,
  stepFlags?: { softDiagnosticsNudge: boolean },
  onComplete?: (call: ToolCall, outcome: ToolOutcome) => Promise<void>
): Promise<Map<string, ToolOutcome>> {
  const results = new Map<string, ToolOutcome>()
  const startedIds = new Set<string>()
  let index = 0
  const workers = Array.from({ length: Math.min(parallelLimit, calls.length) }, async () => {
    while (index < calls.length) {
      if (ctx.signal.aborted) break
      const i = index++
      const call = calls[i]
      if (!call) break
      startedIds.add(call.id)
      const result = await runSingleTool(call, ctx, stepFlags)
      results.set(call.id, result)
      if (onComplete) await onComplete(call, result)
    }
  })
  await Promise.all(workers)
  // After abort, keep settled outcomes; only synthesize abort results for tools
  // that never produced a ToolOutcome. Never re-emit tool_start for started ids.
  if (ctx.signal.aborted) {
    for (const call of calls) {
      const existing = results.get(call.id)
      if (existing) continue
      results.set(
        call.id,
        abortedToolResult(call, ctx, { emitStart: !startedIds.has(call.id) })
      )
    }
  }
  return results
}

/** Execute tool calls with read-only parallelism; preserve call order in output. */
export async function executeStepToolCalls(
  rawCalls: ToolCall[],
  ctx: ToolStepContext
): Promise<{ messages: ChatMessage[]; events: AgentEvent[]; stepToolsOk: boolean }> {
  const calls = ensureToolCallIds(rawCalls, { prefix: 'call_exec' })
  const messages: ChatMessage[] = []
  const events: AgentEvent[] = []
  let stepToolsOk = true
  // Approval gates individual tools; do not force all reads serial.
  const parallelLimit = ctx.maxParallelReadTools ?? MAX_PARALLEL_READ_TOOLS
  const hasDiagnosticsSurface =
    Boolean(ctx.diagnosticsCommand?.trim()) ||
    hasJavaScriptProject(ctx.workspace) ||
    hasTypeScriptProject(ctx.workspace)
  const softDiagnosticsNudge =
    hasDiagnosticsSurface &&
    calls.some((c) => isFileMutationToolName(c.name)) &&
    !calls.some((c) => c.name === 'diagnostics')
  const stepFlags = softDiagnosticsNudge ? { softDiagnosticsNudge: true } : undefined

  const groups: ToolCall[][] = []
  let batch: ToolCall[] = []
  // Approval gate can park network tools; never open multiple cards in parallel.
  const hasApprovalGate = Boolean(ctx.approval)

  const canParallelBatch = (name: string): boolean => {
    if (!isParallelSafeTool(name)) return false
    return true
  }

  const batchLimitFor = (_name: string): number => parallelLimit

  const flushBatch = (): void => {
    if (batch.length === 0) return
    const limit = batchLimitFor(batch[0]!.name)
    while (batch.length > 0) {
      groups.push(batch.splice(0, Math.min(limit, batch.length)))
    }
  }

  for (const call of calls) {
    if (canParallelBatch(call.name)) {
      if (batch.length > 0 && batch[0]!.name !== call.name) {
        flushBatch()
      }
      batch.push(call)
      if (batch.length >= batchLimitFor(call.name)) flushBatch()
    } else {
      flushBatch()
      groups.push([call])
    }
  }
  flushBatch()

  const collect = async (outcome: ToolOutcome): Promise<void> => {
    // Full output must be durable before the truncated live event can be expanded.
    await ctx.appendMessage(outcome.message)
    persistToolResult(ctx, outcome)
    for (const ev of outcome.events) emitToolResult(ctx, ev)
    messages.push(outcome.message)
    events.push(...outcome.events)
    if (!outcome.ok) stepToolsOk = false
  }

  for (const group of groups) {
    if (ctx.signal.aborted) {
      for (const call of group) await collect(abortedToolResult(call, ctx))
      continue
    }

    const parallel =
      group.length > 1 && group.every((c) => canParallelBatch(c.name))
    if (parallel) {
      const batchLimit = batchLimitFor(group[0]!.name)
      const liveCollected = new Set<string>()
      const batch = await runParallelBatch(group, ctx, batchLimit, stepFlags, async (call, outcome) => {
        liveCollected.add(call.id)
        await collect(outcome)
      })
      for (const call of group) {
        if (liveCollected.has(call.id)) continue
        await collect(batch.get(call.id) ?? abortedToolResult(call, ctx))
      }
    } else {
      for (const call of group) {
        if (ctx.signal.aborted) {
          await collect(abortedToolResult(call, ctx))
          continue
        }
        await collect(await runSingleTool(call, ctx, stepFlags))
      }
    }
  }

  return { messages, events, stepToolsOk }
}

export { isMalformedToolCall }
