import { createHash } from 'crypto'

/** After this many consecutive all-failure tool steps, run read-only tools one at a time. */
export const CONSECUTIVE_TOOL_FAILURE_SERIAL_THRESHOLD = 2

/** Stop the run after this many consecutive steps with a failed tool call. */
export const MAX_CONSECUTIVE_TOOL_FAILURE_STEPS = 8

/** Stop the run when the same tool call(s) (name + args) repeats this many steps in a row. */
export const MAX_IDENTICAL_STEP_STREAK = 6

export type LoopStopReason = 'tool_failure_streak' | 'identical_step_streak'

export type LoopStop = { reason: LoopStopReason; message: string }

/**
 * After this many not-in-catalog failures for the *same* MCP tool name in a run,
 * harden the error so the model stops wasting full steps retrying.
 */
export const MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD = 2

const WRITE_TOOLS = new Set(['edit', 'str_replace', 'multi_edit'])
const FILE_MUTATION_TOOLS = new Set([...WRITE_TOOLS, 'delete'])

const MCP_NOT_IN_CATALOG_MARKER = "is not in this step's tool catalog"

/** True when a tool result describes an MCP not-in-catalog rejection. */
export function isMcpNotInCatalogError(content: string): boolean {
  return content.includes(MCP_NOT_IN_CATALOG_MARKER)
}

/**
 * Increment the run-scoped not-in-catalog counter for `toolName`.
 * Returns the new count.
 */
export function recordMcpNotInCatalogFailure(
  counts: Map<string, number>,
  toolName: string
): number {
  const next = (counts.get(toolName) ?? 0) + 1
  counts.set(toolName, next)
  return next
}

/** First rejection: steer toward pin-once-then-wait. */
export function mcpNotInCatalogErrorMessage(
  toolName: string,
  opts?: { alreadyPinned?: boolean }
): string {
  const pinNote = opts?.alreadyPinned
    ? `It is already pinned — wait for the next model step so the sticky catalog can admit it.`
    : `Use mcp_list_tools then request_mcp_tools to pin it once, then wait for the next model step (do not keep calling it this step).`
  return [
    `MCP tool "${toolName}" ${MCP_NOT_IN_CATALOG_MARKER} (omitted by context budget, idle unload, or mode).`,
    pinNote
  ].join(' ')
}

/** Repeated rejection for the same tool — fail-fast to cut wasted steps. */
export function mcpNotInCatalogFailFastMessage(toolName: string, failureCount: number): string {
  return [
    `FAIL-FAST: MCP tool "${toolName}" was rejected as not-in-catalog ${failureCount} times this run.`,
    'Stop calling it. Pin once with request_mcp_tools if needed and wait for the next step, or use a built-in/alternate approach.',
    'Further retries while it remains omitted will not succeed and waste context tokens.'
  ].join(' ')
}

/** Loop hint when one or more MCP tools hit the not-in-catalog fail-fast threshold. */
export function loopHintForMcpNotInCatalogFailFast(
  toolNames: readonly string[]
): string | undefined {
  if (toolNames.length === 0) return undefined
  const preview = toolNames.slice(0, 6).join(', ')
  const more = toolNames.length > 6 ? ` (+${toolNames.length - 6} more)` : ''
  return [
    `Repeated not-in-catalog MCP calls for: ${preview}${more}.`,
    'Do not retry those tools. Pin with request_mcp_tools once if needed, then wait for the next step so pins append into the sticky catalog.'
  ].join(' ')
}

/** Tell the model which MCP tools were dropped from the tools catalog this run. */
export function loopHintForOmittedMcpTools(omittedNames: readonly string[]): string | undefined {
  if (omittedNames.length === 0) return undefined
  const preview = omittedNames.slice(0, 8).join(', ')
  const more = omittedNames.length > 8 ? ` (+${omittedNames.length - 8} more)` : ''
  return [
    `${omittedNames.length} MCP tool(s) were deferred from this step's catalog (unpinned by default / tools soft cap): ${preview}${more}.`,
    'mcp_list_tools shows connected tools (including deferred). Call request_mcp_tools to pin needed tools for the next step, or disable unused MCP servers in Settings → Marketplace.'
  ].join(' ')
}

/** Tell the model pinned MCP schemas were unloaded (idle TTL / soft max / release). */
export function loopHintForEvictedMcpTools(evictedNames: readonly string[]): string | undefined {
  if (evictedNames.length === 0) return undefined
  const preview = evictedNames.slice(0, 8).join(', ')
  const more = evictedNames.length > 8 ? ` (+${evictedNames.length - 8} more)` : ''
  return [
    `${evictedNames.length} pinned MCP tool(s) were unloaded from this step's catalog (idle TTL or pinned soft max): ${preview}${more}.`,
    'Call request_mcp_tools to pin them again for the next step if still needed. Prefer release_mcp_tools when finished with a server to free schema tokens sooner.'
  ].join(' ')
}

/** Composer status line when MCP tools are shed for context budget. */
export function runNoticeForOmittedMcpTools(omittedCount: number): string | undefined {
  if (omittedCount <= 0) return undefined
  const n = omittedCount === 1 ? '1 MCP tool was' : `${omittedCount} MCP tools were`
  return `${n} deferred from the step catalog — pin with request_mcp_tools, or disable unused MCP servers in Settings → Marketplace.`
}

export function combineLoopHints(...hints: Array<string | undefined>): string | undefined {
  const parts = hints.map((h) => h?.trim()).filter((h): h is string => Boolean(h))
  return parts.length ? parts.join('\n\n') : undefined
}

/** When auto-compaction runs but produces no summary (provider error / empty). */
export function loopHintForCompactionFailure(): string {
  return [
    'Automatic history compaction produced no summary; older turns were trimmed to keep recent context.',
    'Move durable facts into memory, ask the user to run /compact, or /clear when starting an unrelated task.'
  ].join(' ')
}

/** When the compaction LLM is skipped because it would not pay back under the soft trigger. */
export function loopHintForCompactionPaybackSkip(reason: string): string {
  const base =
    reason === 'residual_above_trigger'
      ? 'Compaction LLM skipped — even a summary would leave context above the soft trigger.'
      : reason === 'prefer_trim'
        ? 'Compaction LLM skipped — prior summary exists; trimmed instead of re-summarizing.'
        : 'Compaction LLM skipped — foldable history too small to justify a summarize call.'
  return `${base} Prefer /clear between unrelated tasks, or /compact when you need continuity.`
}

/** Composer / run notice when high thinking effort runs long (does not change settings). */
export function runNoticeForHighThinkingCost(step: number): string {
  return `High thinking effort is still on at step ${step} — reasoning tokens accumulate every step. Lower effort in the composer for simpler work, or /clear between tasks.`
}

/** Composer notice when context remains far above the soft compaction trigger. */
export function runNoticeForContextAboveSoftTrigger(): string {
  return 'Context is still large after compaction. Prefer /clear for a new task, or /compact with a focus while continuing this one.'
}

export function maxParallelReadToolsForFailureStreak(
  streak: number,
  defaultMax: number
): number {
  if (streak >= CONSECUTIVE_TOOL_FAILURE_SERIAL_THRESHOLD) return 1
  return defaultMax
}

export function normalizeWorkspaceRelPath(path: string): string {
  return path.trim().replace(/\\/g, '/')
}

function parseToolArgs(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore malformed args
  }
  return {}
}

export function editPathsFromToolCall(
  name: string,
  args: Record<string, unknown>
): string[] {
  if (name === 'edit' || name === 'str_replace') {
    const path = typeof args.path === 'string' ? normalizeWorkspaceRelPath(args.path) : ''
    return path ? [path] : []
  }
  if (name === 'multi_edit' && Array.isArray(args.edits)) {
    const paths: string[] = []
    for (const entry of args.edits) {
      if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
        const path = normalizeWorkspaceRelPath((entry as { path: string }).path)
        if (path) paths.push(path)
      }
    }
    return paths
  }
  return []
}

/** Concrete path targeted by a successful `delete` tool call. */
export function deletePathFromToolCall(
  name: string,
  args: Record<string, unknown>
): string | null {
  if (name !== 'delete') return null
  const path = typeof args.path === 'string' ? normalizeWorkspaceRelPath(args.path) : ''
  return path || null
}

/**
 * Drop a deleted path and any descendant paths from the inspect/edit set.
 * Always clears descendants: `toolDelete` removes directory trees on success
 * (empty dirs or `recursive=true`), so stale child inspects must not survive.
 */
export function invalidateKnownPathsAfterDelete(known: Set<string>, deletedPath: string): void {
  const path = normalizeWorkspaceRelPath(deletedPath)
  if (!path) return
  known.delete(path)
  const prefix = path.endsWith('/') ? path : `${path}/`
  for (const entry of [...known]) {
    if (entry.startsWith(prefix)) known.delete(entry)
  }
}

export function readPathFromToolCall(
  name: string,
  args: Record<string, unknown>
): string | null {
  if (name !== 'read') return null
  const path = typeof args.path === 'string' ? normalizeWorkspaceRelPath(args.path) : ''
  return path || null
}

/** True when a path/glob string names a single concrete file (no wildcards). */
export function isConcreteWorkspacePath(value: string): boolean {
  const path = normalizeWorkspaceRelPath(value)
  if (!path || path === '.' || path === '..') return false
  if (/[*?[{]/.test(path)) return false
  return true
}

/** Tools whose successful concrete paths count as inspect for path tracking. */
export function isInspectToolName(name: string): boolean {
  return name === 'read' || name === 'grep' || name === 'glob'
}

/** Tools whose successful results can make earlier diagnostics stale. */
export function isFileMutationToolName(name: string): boolean {
  return FILE_MUTATION_TOOLS.has(name)
}

/**
 * Paths that count as “seen”: `read`, or concrete `grep` include / `glob` pattern
 * (no wildcards).
 */
export function inspectPathsFromToolCall(
  name: string,
  args: Record<string, unknown>
): string[] {
  if (name === 'read') {
    const path = readPathFromToolCall(name, args)
    return path ? [path] : []
  }
  if (name === 'grep') {
    // Canonical `include`; coerce also maps hallucinated `path` → include before validate.
    const raw = typeof args.include === 'string' ? args.include : args.path
    if (typeof raw === 'string' && isConcreteWorkspacePath(raw)) {
      return [normalizeWorkspaceRelPath(raw)]
    }
    return []
  }
  if (name === 'glob') {
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    if (isConcreteWorkspacePath(pattern)) return [normalizeWorkspaceRelPath(pattern)]
    return []
  }
  return []
}

export function applyToolCallToKnownPaths(
  known: Set<string>,
  name: string,
  args: Record<string, unknown>,
  ok: boolean
): void {
  if (!ok) return
  const deleted = deletePathFromToolCall(name, args)
  if (deleted) {
    invalidateKnownPathsAfterDelete(known, deleted)
    return
  }
  for (const path of inspectPathsFromToolCall(name, args)) {
    known.add(path)
  }
  for (const path of editPathsFromToolCall(name, args)) {
    known.add(path)
  }
}

export function unreadExistingEditPaths(
  known: ReadonlySet<string>,
  name: string,
  args: Record<string, unknown>,
  pathExists: (rel: string) => boolean
): string[] {
  if (!WRITE_TOOLS.has(name)) return []
  const unread: string[] = []
  for (const path of editPathsFromToolCall(name, args)) {
    if (known.has(path)) continue
    if (!pathExists(path)) continue
    unread.push(path)
  }
  return unread
}

/**
 * Track paths a successful tool call actually changed (edits + deletes, no reads).
 * Used to scope git_commit staging to files the agent touched this run.
 */
export function applyToolCallToMutationPaths(
  mutations: Set<string>,
  name: string,
  args: Record<string, unknown>,
  ok: boolean
): void {
  if (!ok) return
  const deleted = deletePathFromToolCall(name, args)
  if (deleted) {
    mutations.add(normalizeWorkspaceRelPath(deleted))
    return
  }
  for (const path of editPathsFromToolCall(name, args)) {
    mutations.add(path)
  }
}

/** Seed mutation paths from the transcript so scoped commits survive reloads. */
export function seedMutationPathsFromMessages(messages: readonly SeedMessage[]): Set<string> {
  const mutations = new Set<string>()
  const successfulCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId && msg.ok !== false) {
      successfulCallIds.add(msg.toolCallId)
    }
  }
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        if (!successfulCallIds.has(call.id)) continue
        applyToolCallToMutationPaths(mutations, call.name, parseToolArgs(call.arguments), true)
      }
    }
  }
  return mutations
}

type SeedMessage = {
  role: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  toolCallId?: string
  toolName?: string
  ok?: boolean
  content?: unknown
}

/**
 * Seed known paths from transcript (used by receipts for unread-edit observation).
 * Only calls with a matching successful tool result count as seen.
 */
export function seedKnownPathsFromMessages(messages: readonly SeedMessage[]): Set<string> {
  const known = new Set<string>()
  const successfulCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId && msg.ok !== false) {
      successfulCallIds.add(msg.toolCallId)
    }
  }
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        if (!successfulCallIds.has(call.id)) continue
        const args = parseToolArgs(call.arguments)
        applyToolCallToKnownPaths(known, call.name, args, true)
      }
    }
  }
  return known
}

/** Parse tool-call argument JSON for loop wiring. */
export function toolArgsFromCall(argumentsJson: string): Record<string, unknown> {
  return parseToolArgs(argumentsJson)
}

/** Stable fingerprint of one step's tool calls (name + args, order-sensitive). */
export function stepToolCallsFingerprint(
  calls: ReadonlyArray<{ name: string; arguments: string }>
): string {
  return createHash('sha256')
    .update(calls.map((c) => `${c.name}\n${c.arguments ?? ''}`).join('\n\n'))
    .digest('hex')
    .slice(0, 16)
}

/** Next identical-step streak: +1 when the fingerprint repeats, else reset to 1. */
export function nextIdenticalStepStreak(
  prevFingerprint: string,
  prevStreak: number,
  fingerprint: string
): number {
  return fingerprint === prevFingerprint ? prevStreak + 1 : 1
}

/** Central loop-safety decision for consecutive tool-failure / identical tool-step streaks. */
export function loopStopDecision(state: {
  /** Progress metadata only — not a stop condition. */
  step: number
  consecutiveToolFailureSteps: number
  identicalStepStreak: number
}): LoopStop | undefined {
  if (state.consecutiveToolFailureSteps >= MAX_CONSECUTIVE_TOOL_FAILURE_STEPS) {
    return {
      reason: 'tool_failure_streak',
      message: `Stopped after ${state.consecutiveToolFailureSteps} consecutive steps with a failed tool call. Inspect the last tool errors, adjust, and retry.`
    }
  }
  if (state.identicalStepStreak >= MAX_IDENTICAL_STEP_STREAK) {
    return {
      reason: 'identical_step_streak',
      message: `Stopped after the same tool call(s) repeated ${state.identicalStepStreak} consecutive tool steps in a row (likely a loop). Change approach, or start a new chat with fresh context.`
    }
  }
  return undefined
}
