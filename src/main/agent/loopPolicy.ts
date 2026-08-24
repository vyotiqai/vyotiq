import { createHash } from 'crypto'
import type { ChatMessage } from '../../shared/ipc'
import { contentToText } from '../../shared/ipc'
import { codebaseSearchHitPathsFromResult } from './codeindex/search'
import { readPathArg } from './tools/argAccess'
import { searchHitPathsFromResult } from './tools/search'
import { loopHintForRetainedDecisions } from './context/retainedDecisions'

/** Stop the run after this many consecutive steps with a failed tool call. */
export const MAX_CONSECUTIVE_TOOL_FAILURE_STEPS = 8

/** Stop the run when the same tool call(s) (name + args) repeats this many steps in a row. */
export const MAX_IDENTICAL_STEP_STREAK = 3

export type LoopStopReason = 'tool_failure_streak' | 'identical_step_streak'

export type LoopStop = { reason: LoopStopReason; message: string }

/**
 * After this many not-in-catalog failures for the *same* MCP tool name in a run,
 * harden the error so the model stops wasting full steps retrying.
 */
export const MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD = 2

const WRITE_TOOLS = new Set(['edit', 'str_replace', 'multi_edit', 'edit_notebook'])
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
    `MCP tool "${toolName}" ${MCP_NOT_IN_CATALOG_MARKER} (omitted by context budget or mode).`,
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

/** Tell the model which pinned MCP tools were dropped from the tools catalog this step (budget). */
export function loopHintForOmittedMcpTools(omittedNames: readonly string[]): string | undefined {
  if (omittedNames.length === 0) return undefined
  const preview = omittedNames.slice(0, 8).join(', ')
  const more = omittedNames.length > 8 ? ` (+${omittedNames.length - 8} more)` : ''
  return [
    `${omittedNames.length} pinned MCP tool(s) were omitted from this step's catalog to fit the tools budget: ${preview}${more}.`,
    'Release unused pins with release_mcp_tools, disable unused MCP servers in Marketplace → Manage, then pin again with request_mcp_tools if still needed.'
  ].join(' ')
}

/** Tell the model pinned MCP schemas were unloaded (unused TTL or release_mcp_tools). */
export function loopHintForEvictedMcpTools(evictedNames: readonly string[]): string | undefined {
  if (evictedNames.length === 0) return undefined
  const preview = evictedNames.slice(0, 8).join(', ')
  const more = evictedNames.length > 8 ? ` (+${evictedNames.length - 8} more)` : ''
  return [
    `${evictedNames.length} pinned MCP tool(s) were unloaded from this step's catalog: ${preview}${more}.`,
    'Call request_mcp_tools to pin them again for the next step if still needed. Prefer release_mcp_tools when finished with a server to free schema tokens sooner.'
  ].join(' ')
}

export function combineLoopHints(...hints: Array<string | undefined>): string | undefined {
  const parts = hints.map((h) => h?.trim()).filter((h): h is string => Boolean(h))
  return parts.length ? parts.join('\n\n') : undefined
}

/** When auto-compaction cannot fold yet (too little history / nothing foldable). */
export function loopHintForCompactionFailure(): string {
  return [
    'Automatic history compaction had nothing foldable yet (history too short or already recent).',
    'Move durable facts into memory with memory_write.'
  ].join(' ')
}

/** When the summarizer output failed extractive verification and was discarded. */
export function loopHintForCompactionVerifyFailed(): string {
  return [
    'Automatic history compaction produced a summary that failed verification and was not applied.',
    'Move durable facts into memory with memory_write.'
  ].join(' ')
}

export function loopHintAfterCompaction(
  decisions?: readonly string[]
): string | undefined {
  return loopHintForRetainedDecisions(decisions)
}

/** Model loop hint when context remains far above the soft compaction trigger. */
export function runNoticeForContextAboveSoftTrigger(): string {
  return 'Context is still large after compaction. Continue; auto-compact will fold again at the next threshold. Move durable facts into memory with memory_write.'
}

/** Summarize the most recent failed tool message for loop hints. */
export function summarizeRecentToolFailure(
  messages: ReadonlyArray<ChatMessage>
): { tool: string; summary: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'tool' || msg.ok !== false || !msg.toolName?.trim()) continue
    return {
      tool: msg.toolName.trim(),
      summary: contentToText(msg.content).trim().slice(0, 240)
    }
  }
  return undefined
}

/** System loop hint when identical tool call(s) repeat (before hard stop). */
export function loopHintForIdenticalStepStreak(streak: number): string | undefined {
  if (streak < 2) return undefined
  if (streak >= MAX_IDENTICAL_STEP_STREAK) {
    return 'The same tool call(s) repeated — change approach instead of retrying identical arguments.'
  }
  return 'You repeated the same tool call shape — adjust arguments or choose a different tool before retrying.'
}

/** System loop hint when tool calls fail repeatedly (structured feedback pattern). */
export function loopHintForConsecutiveToolFailures(
  streak: number,
  recent?: { tool: string; summary: string }
): string | undefined {
  if (streak < 2) return undefined

  const lines = [
    streak >= 4
      ? `Tool calls have failed ${streak} steps in a row — stop repeating the same call shape.`
      : 'Recent tool calls failed — read the last tool_result errors before retrying.'
  ]

  if (
    recent?.tool === 'edit' &&
    /empty arguments|empty contents|path: Required|truncated during streaming/i.test(recent.summary)
  ) {
    lines.push(
      'edit requires path plus non-empty contents (full file) or diff (unified @@ hunks). Never call edit with {}. Use diff to remove contents explicitly.'
    )
  } else if (
    recent?.tool === 'str_replace' &&
    /empty arguments|path: Required|truncated during streaming/i.test(recent.summary)
  ) {
    lines.push('str_replace requires path, old_string, and new_string — never call it with {}.')
  } else if (
    recent?.tool === 'multi_edit' &&
    /empty arguments|empty contents|edits(?:\.|:)|each edit requires|truncated during streaming/i.test(recent.summary)
  ) {
    lines.push(
      'multi_edit requires edits: [{ path, contents }] or edits: [{ path, diff }]. Send each complete edit object together. Empty contents cannot replace an existing non-empty file; use diff to remove contents explicitly.'
    )
  } else if (
    recent?.tool === 'todo_write' &&
    /empty arguments|todos: Required|invalid args/i.test(recent.summary)
  ) {
    lines.push(
      'todo_write requires todos: [{ id, content, status }] or merge:true with an empty todos list.'
    )
  } else if (
    recent?.tool === 'ask_question' &&
    /question or questions is required|questions must contain at least 1|questions\[.*\]\.type must be|questions\[.*\]\.prompt is required|must be a JSON array|must be one complete JSON object|Invalid arguments/i.test(
      recent.summary
    )
  ) {
    lines.push(
      'ask_question requires questions: [{ id, prompt, type: "boolean"|"text"|"single"|"multi", options? }] or legacy { question: "…" }. Never call it with {}.'
    )
  } else if (
    recent?.tool === 'read' &&
    /offset\/limit cannot be combined with startLine\/endLine/i.test(recent.summary)
  ) {
    lines.push(
      'read: omit offset/limit when using startLine/endLine. offset/limit is a byte window, not a line range.'
    )
  }

  if (streak >= 6) {
    lines.push(
      'If context looks stale, narrow the task or memory_write durable facts.'
    )
  }

  return lines.join(' ')
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
  if (name === 'edit' || name === 'str_replace' || name === 'edit_notebook') {
    const raw =
      name === 'edit_notebook' && typeof args.target_notebook === 'string'
        ? args.target_notebook
        : readPathArg(args)
    const path = raw ? normalizeWorkspaceRelPath(raw) : ''
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
  const raw = readPathArg(args)
  const path = raw ? normalizeWorkspaceRelPath(raw) : ''
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
  const raw = readPathArg(args)
  const path = raw ? normalizeWorkspaceRelPath(raw) : ''
  return path || null
}

/** True when a path/glob string names a single concrete file (no wildcards). */
export function isConcreteWorkspacePath(value: string): boolean {
  const path = normalizeWorkspaceRelPath(value)
  if (!path || path === '.' || path === '..') return false
  if (/[*?[{]/.test(path)) return false
  return true
}

/**
 * Receipt/checkpoint paths must look like real workspace files — not comma-glued
 * command args, bare punctuation, or assertion fragments from terminal output.
 */
export function isPlausibleWorkspaceFilePath(value: string): boolean {
  const path = normalizeWorkspaceRelPath(value)
  if (!isConcreteWorkspacePath(path)) return false
  if (path.includes(',')) return false
  if (/[;|&<>]/.test(path)) return false
  if (/^[=+-]+$/.test(path)) return false
  if (path.includes(')') && !path.includes('(')) return false
  if (!path.includes('/') && !/\.[a-zA-Z0-9][\w.-]*$/.test(path)) return false
  return true
}

/** Tools whose successful concrete paths count as inspect for path tracking. */
export function isInspectToolName(name: string): boolean {
  return (
    name === 'read' ||
    name === 'list_dir' ||
    name === 'grep' ||
    name === 'glob' ||
    name === 'search' ||
    name === 'codebase_search'
  )
}

/** Tools whose successful results can make earlier diagnostics stale. */
export function isFileMutationToolName(name: string): boolean {
  return FILE_MUTATION_TOOLS.has(name)
}

/**
 * Paths that count as “seen”: `read`, concrete `grep` include / `glob` pattern
 * (no wildcards), `search` hit paths, or `codebase_search` hit paths from tool result text.
 */
export function inspectPathsFromToolCall(
  name: string,
  args: Record<string, unknown>,
  resultContent?: string
): string[] {
  if (name === 'read') {
    const path = readPathFromToolCall(name, args)
    return path ? [path] : []
  }
  if (name === 'grep') {
    // Prefer `include`; fall back to hallucinated `path` for known-path tracking only.
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
  if (name === 'list_dir') {
    const path = typeof args.path === 'string' ? normalizeWorkspaceRelPath(args.path) : ''
    if (path && isConcreteWorkspacePath(path)) return [path]
    return []
  }
  if (name === 'search' && typeof resultContent === 'string' && resultContent) {
    return searchHitPathsFromResult(resultContent)
      .map((p) => normalizeWorkspaceRelPath(p))
      .filter((p) => isConcreteWorkspacePath(p))
  }
  if (name === 'codebase_search' && typeof resultContent === 'string' && resultContent) {
    return codebaseSearchHitPathsFromResult(resultContent)
      .map((p) => normalizeWorkspaceRelPath(p))
      .filter((p) => isConcreteWorkspacePath(p))
  }
  return []
}

export function applyToolCallToKnownPaths(
  known: Set<string>,
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  resultContent?: string
): void {
  if (!ok) return
  const deleted = deletePathFromToolCall(name, args)
  if (deleted) {
    invalidateKnownPathsAfterDelete(known, deleted)
    return
  }
  for (const path of inspectPathsFromToolCall(name, args, resultContent)) {
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
  const resultByCallId = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId && msg.ok !== false) {
      successfulCallIds.add(msg.toolCallId)
      if (typeof msg.content === 'string') {
        resultByCallId.set(msg.toolCallId, msg.content)
      }
    }
  }
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        if (!successfulCallIds.has(call.id)) continue
        const args = parseToolArgs(call.arguments)
        applyToolCallToKnownPaths(known, call.name, args, true, resultByCallId.get(call.id))
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

/** Central loop-safety decision — never stops the run. */
export function loopStopDecision(_state: {
  /** Progress metadata only — not a stop condition. */
  step: number
  consecutiveToolFailureSteps?: number
  identicalStepStreak: number
}): LoopStop | undefined {
  return undefined
}
