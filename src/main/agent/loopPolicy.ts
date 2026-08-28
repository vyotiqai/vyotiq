import { createHash } from 'crypto'
import type { ChatMessage } from '../../shared/ipc'
import { contentToText } from '../../shared/ipc'
import { codebaseSearchHitPathsFromResult } from './codeindex/search'
import { readPathArg } from './tools/argAccess'
import { searchHitPathsFromResult } from './tools/search'
import { loopHintForRetainedDecisions } from './context/retainedDecisions'

/** Stop the run when the same tool call(s) (name + args) repeats this many steps in a row. */
export const MAX_IDENTICAL_STEP_STREAK = 3

/**
 * Terminal stop when the same tool call(s) repeat this many steps in a row.
 * Below this ceiling identical repeats steer via the escalating hint
 * (loopHintForIdenticalStepStreak); the loop treats this reason as terminal.
 */
export const MAX_IDENTICAL_STEP_STREAK_TERMINAL = 8

/**
 * Stop the run after this many consecutive steps whose tool calls all failed.
 * Mirrors the "failed 4 steps in a row" loop hint threshold.
 */
export const MAX_CONSECUTIVE_TOOL_FAILURE_STEPS = 4

/**
 * Cap auto-continuation after the model output is truncated. Each continuation
 * re-sends the full context, so an unbounded loop burns tokens with no progress.
 * A legitimate truncation almost never needs more than a handful of continuations.
 */
export const MAX_TRUNCATION_CONTINUES = 8

/**
 * Cap auto-continuation after the model returns an empty response. Repeated
 * empty responses are never productive and must not loop forever.
 */
export const MAX_EMPTY_RESPONSE_CONTINUES = 4

/**
 * Hard step ceiling for a single user turn. Without it, a run that alternates
 * distinct (non-identical) tool calls can loop indefinitely, paying for
 * compaction cycles each time the window refills. Generous by design — real
 * long turns (large refactors) land well under a few hundred steps — so only
 * genuine runaway loops hit it.
 */
export const MAX_STEPS_PER_TURN = 500

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
    `MCP tool "${toolName}" ${MCP_NOT_IN_CATALOG_MARKER} (excluded by mode or catalog policy).`,
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
    (recent?.tool === 'edit' || recent?.tool === 'multi_edit') &&
    /Diff hunk failed to match|Diff hunk .* matched \d+/i.test(recent.summary)
  ) {
    lines.push(
      'edit diff did not match the file. Re-read the current bytes and send a hunk whose context/removal lines match exactly.'
    )
  } else if (
    recent?.tool === 'str_replace' &&
    /empty arguments|path: Required|truncated during streaming/i.test(recent.summary)
  ) {
    lines.push('str_replace requires path, old_string, and new_string — never call it with {}.')
  } else if (
    (recent?.tool === 'str_replace' || recent?.tool === 'edit_notebook') &&
    /old_string not found/i.test(recent.summary)
  ) {
    lines.push(
      'str_replace old_string was not found. Re-read with startLine/endLine and retry with an exact snippet (indentation and newlines).'
    )
  } else if (recent?.tool === 'multi_edit' && /duplicate path/i.test(recent.summary)) {
    lines.push(
      'multi_edit cannot list the same path twice — combine those edits into one entry.'
    )
  } else if (
    recent?.tool === 'multi_edit' &&
    /empty arguments|empty contents|edits(?:\.|:)|each edit requires|truncated during streaming/i.test(
      recent.summary
    )
  ) {
    lines.push(
      'multi_edit requires edits: [{ path, contents }] or edits: [{ path, diff }]. Send each complete edit object together. Empty contents cannot replace an existing non-empty file; use diff to remove contents explicitly.'
    )
  } else if (
    recent?.tool === 'todo_write' &&
    /empty arguments|todos(?:\.|:)|invalid args/i.test(recent.summary)
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
  } else if (/Duplicate JSON key/i.test(recent?.summary ?? '')) {
    lines.push(
      'Duplicate JSON key — JSON keeps only the last value. Call the tool once per file (one path per call).'
    )
  } else if (/Path escapes workspace/i.test(recent?.summary ?? '')) {
    lines.push(
      'That path is outside the workspace root. Use a workspace-relative path; read/list_dir cannot open AppData, home, or other-drive locations.'
    )
  } else if (/Plan mode may only edit plan\.md or contract\.md/i.test(recent?.summary ?? '')) {
    lines.push(
      'Plan mode cannot edit product files. Call switch_mode with mode "agent" before editing code, or keep edits on plan.md / contract.md.'
    )
  } else if (
    recent?.tool === 'terminal' &&
    /\.docx/i.test(recent.summary) &&
    /ZipFile|document\.xml|Do not unzip Word|extracted document text/i.test(recent.summary)
  ) {
    lines.push(
      'Do not unzip Word .docx in the terminal. Call read on the .docx path — it returns extracted document text.'
    )
  } else if (
    recent?.tool === 'terminal' &&
    /is not recognized as the name of a cmdlet|is not recognized as an internal or external command|command not found|That command is not on PATH/i.test(
      recent.summary
    ) &&
    !/The term '=' is not recognized/i.test(recent.summary)
  ) {
    lines.push(
      'That command is not on PATH. Do not retry the same invocation. Locate the executable or state the missing toolchain.'
    )
  } else if (recent?.tool === 'terminal' && /Unexpected token '\.[A-Za-z_]/i.test(recent.summary)) {
    lines.push(
      'PowerShell member access cannot have a space before the dot. Write $_.Line not $_ .Line. To scan a log file, Get-Content $path first — do not -split the path string.'
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
  // PowerShell env paths (`$env:TEMP/…`) are not workspace files.
  if (path.startsWith('$')) return false
  if (/^[=+-]+$/.test(path)) return false
  if (path.includes(')') && !path.includes('(')) return false
  if (!path.includes('/') && !/\.[a-zA-Z0-9][\w.-]*$/.test(path)) return false
  return true
}

/**
 * Compiler output that opaque `dotnet`/`msbuild` watches used to record as
 * agent writes (receipt 92c049d6: 1541 bin/Debug files).
 */
export function isBuildOutputRelPath(value: string): boolean {
  const path = normalizeWorkspaceRelPath(value)
  return /(?:^|\/)(?:bin\/(?:Debug|Release)(?:\/|$)|obj\/)/i.test(path)
}

/** Run-cancel / steer stubs — not agent tool errors. */
export function isAbortStubToolResult(content: string): boolean {
  const text = content.trim()
  return text === 'Cancelled' || text === 'Interrupted'
}

/**
 * Failures that never mutated the file. Counting them as unread-before-edit
 * poisoned harness review (Plan-mode memory-path edits on run 75135925).
 */
export function isNonMutatingWriteFailure(content: string): boolean {
  if (isAbortStubToolResult(content)) return true
  if (/Plan mode may only edit plan\.md or contract\.md/i.test(content)) return true
  if (/Ask mode does not allow tool "/i.test(content)) return true
  if (/Path escapes workspace/i.test(content)) return true
  return false
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

/**
 * Central loop-safety decision. Stops the run when it is clearly spinning:
 * the same tool call(s) repeating, or tool calls failing every step. These
 * signals are already collected per step in `loop.ts`; previously this always
 * returned `undefined`, so the agent could iterate forever burning tokens.
 */
export function loopStopDecision(state: {
  step: number
  consecutiveToolFailureSteps?: number
  identicalStepStreak: number
}): LoopStop | undefined {
  if (state.identicalStepStreak >= MAX_IDENTICAL_STEP_STREAK_TERMINAL) {
    return {
      reason: 'identical_step_streak',
      message: `Stopping: the same tool call(s) repeated ${state.identicalStepStreak} steps in a row. Change approach instead of retrying identical arguments.`
    }
  }
  const failures = state.consecutiveToolFailureSteps ?? 0
  if (failures >= MAX_CONSECUTIVE_TOOL_FAILURE_STEPS) {
    return {
      reason: 'tool_failure_streak',
      message: `Stopping: tool calls failed ${failures} steps in a row. Resolve the underlying error or change approach.`
    }
  }
  return undefined
}

export type RunBudgetLimits = {
  /** Per-run spend ceiling in USD (provider-reported cumulative billed cost). 0 disables. */
  runSpendLimitUsd?: number
  /** Per-run token ceiling (cumulative billed input + output tokens). 0 disables. */
  runTokenLimit?: number
}

/**
 * Per-run budget guard decision. Returns the terminal message when cumulative
 * spend or tokens have reached the configured limit; undefined keeps the run
 * going. Checked at the step boundary where step_usage totals already exist.
 */
export function runBudgetStopMessage(
  limits: RunBudgetLimits,
  totals: { billedCost: number; billedInputTokens: number; outputTokens: number }
): string | undefined {
  const spendLimit = limits.runSpendLimitUsd ?? 0
  if (spendLimit > 0 && totals.billedCost >= spendLimit) {
    return `This run reached its spend limit ($${spendLimit.toFixed(2)}; $${totals.billedCost.toFixed(2)} billed) and was stopped as a budget guard. Raise or clear the run spend limit in Settings to continue.`
  }
  const tokenLimit = limits.runTokenLimit ?? 0
  if (tokenLimit > 0 && totals.billedInputTokens + totals.outputTokens >= tokenLimit) {
    const used = totals.billedInputTokens + totals.outputTokens
    return `This run reached its token limit (${tokenLimit.toLocaleString('en-US')} tokens; ${used.toLocaleString('en-US')} used) and was stopped as a budget guard. Raise or clear the run token limit in Settings to continue.`
  }
  return undefined
}
