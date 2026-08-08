import { logger, logErrorSummary } from '../../../shared/logger'
import { formatError, isAbortError, isExpectedToolError } from '../../../shared/errors'
import { summarizeToolArgsFromRecord } from '../../../shared/toolSummary'
import { validateToolArgs, type AgentToolName } from '../schemas/tools'
import { invokeMcpTool, parseMcpToolName, getMcpToolDefinition, listMcpToolDefinitions, getMcpReadOnlyHint, assertMcpServerAccess, listMcpResources, readMcpResource, listMcpPrompts, getMcpPrompt, getMcpServerStatus } from '../mcp'
import { resolveEffectiveMcpServers } from '@main/marketplace'
import { isMcpToolPermitted } from '../../../shared/utils/mcpToolPolicy'
import { validateAgainstJsonSchema } from '../schemas/jsonSchemaValidate'
import { toolRead, READ_CONTENT_CAP } from './read'
import { toolEdit } from './edit'
import { toolSearch, SEARCH_DEFAULT_MAX_RESULTS } from './search'
import { toolGlob } from './glob'
import { toolGrep } from './grep'
import { toolListDir } from './listDir'
import { toolMultiEdit, type MultiEditEntry } from './multiEdit'
import { toolStrReplace } from './strReplace'
import { toolDelete } from './deletePath'
import { toolTodoWrite, type TodoItem } from './todo'
import { isFindstrNoMatchContent, isDirMissingPathContent, toolTerminal, TERMINAL_MAX_TIMEOUT_MS } from './terminal'
import { toolMemoryList, toolMemoryRead, toolMemoryWrite } from './memory'
import { toolSkill, summarizeSkillArgs } from './skill'
import { toolGitDiffAsync, toolGitStatusAsync } from './gitHelpers'
import { toolDiagnosticsAsync } from './diagnostics'
import { toolGenerateImage } from './generateImage'
import { toolEditImage } from './editImage'
import { normalizeOutputFormat } from '../providers/imageGen/mime'
import { getSettings } from '@main/settings/settings'
import { buildSearchUrl } from '../../../shared/utils/searchEngine'
import { getWriteCheckpoint } from '../checkpoints'
import { needsOpaqueWatch, recordTerminalCommandPriors } from './terminalCheckpoint'
import { recordMcpFilesystemPriors } from './mcpCheckpoint'
import {
  applyWatchDiffToCheckpoint,
  diffSince,
  disposeWatch,
  startWatch
} from '../workspaceMutationWatch'
import { resolveInsideWorkspace } from '@main/workspace/safePath'
import { clearWorkspaceSnapshotCache } from '../context/workspaceSnapshot'
import { commitAll, commitPaths } from '@main/git/git'
import { invalidateGitStatusCache } from '@main/git/gitStatusCache'
import { clearGitignoreMatcherCache } from './gitignore'
import type { ToolApprovalGate } from '../toolApproval'
import {
  MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD,
  mcpNotInCatalogErrorMessage,
  mcpNotInCatalogFailFastMessage,
  recordMcpNotInCatalogFailure
} from '../loopPolicy'
import {
  assertToolAllowedInMode,
  isPlanArtifactPath,
  isRunContractPath,
  isRunPlanPath
} from './modePolicy'
import type {
  AgentEvent,
  AgentInteractionMode,
  AgentQuestionAnswer,
  AgentQuestionRequest,
  Settings,
  TerminalShell
} from '../../../shared/ipc'
import { basename, join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { askQuestionThroughRenderer } from '../agentQuestion'
import {
  askQuestionSummary,
  formatQuestionAnswers,
  normalizeAskQuestionArgs
} from '../../../shared/utils/agentQuestionForm'

export interface ToolResult {
  ok: boolean
  summary: string
  content: string
  /** True when tools layer already logged this failure (avoid duplicate agent warn). */
  failureLogged?: boolean
}

/** Run-scoped state a handler may need beyond the workspace path. */
export type ToolExecutionContext = {
  /** Directory of the run that issued the call; absent outside a run. */
  runDir?: string
  /** Run that owns this call; required for ask_question. */
  runId?: string
  /** Provider tool-call id; required for ask_question. */
  toolCallId?: string
  /** ChatStart invoke that owns this call; scopes cancel on abort. */
  invokeId?: number
  /**
   * Hard run-cancel signal only (not soft stream / follow-up interrupt).
   */
  runSignal?: AbortSignal
  /** Ask / Plan / Agent mode for this invoke (prefer getAgentMode when mutable). */
  agentMode?: AgentInteractionMode
  getAgentMode?: () => AgentInteractionMode
  setAgentMode?: (mode: AgentInteractionMode) => void | Promise<void>
  /** Snapshot of settings.autoModeSwitch for this invoke (not live mid-run). */
  autoModeSwitch?: boolean
  /** Snapshot of settings.terminalShell for this invoke (not live mid-run). */
  terminalShell?: TerminalShell
  /** Snapshot of settings.diagnosticsCommand for this invoke (not live mid-run). */
  diagnosticsCommand?: string
  /**
   * Invoke-snapshotted settings for image tools (provider/model/base URL).
   * Prefer over live getSettings() so mid-run settings edits cannot change the invoke.
   */
  imageToolSettings?: Settings
  /** Emit live agent events (e.g. mode_changed) while a tool is running. */
  emitAgentEvent?: (event: AgentEvent) => void
  /** Overridable in tests; defaults to renderer IPC round trip. */
  askQuestion?: (
    request: AgentQuestionRequest,
    signal: AbortSignal
  ) => Promise<AgentQuestionAnswer[]>
  /** Skip write-checkpoint priors (Plan run artifacts are not workspace writes). */
  skipWriteCheckpoint?: boolean
  /** Live progress from a long-running tool, surfaced under its transcript row. */
  onProgress?: (update: { kind: 'text' | 'thinking' | 'tool' | 'done'; text: string }) => void
  /** Incremental terminal stdout/stderr for live UI streaming. */
  onTerminalOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
  /**
   * MCP servers enabled for this run (workspace overrides applied).
   * When set, MCP invokes outside this set are rejected even if globally connected.
   */
  runEnabledMcpIds?: ReadonlySet<string>
  /** Per-server allow/deny policy for bare MCP tool names. */
  mcpToolPolicies?: ReadonlyMap<string, { allowedTools?: string[]; deniedTools?: string[] }>
  /**
   * MCP tool full names offered to the model this step (post budget trim).
   * When set, MCP invokes outside this set are rejected.
   */
  stepMcpToolNames?: ReadonlySet<string>
  /**
   * Run-scoped MCP tools the agent pinned via request_mcp_tools.
   * Applied on the next refresh/trim (not mid-stream).
   */
  runPinnedMcpToolNames?: Set<string>
  /** Last step each MCP tool was pinned or invoked (idle TTL / LRU). */
  mcpLastUsedByName?: Map<string, number>
  /** Current agent step (for pin / invoke last-used stamps). */
  currentStep?: number
  /** Invalidate the loop MCP catalog cache after pinning. */
  invalidateMcpToolCatalogCache?: () => void
  /**
   * Run-scoped counts of MCP not-in-catalog rejections (per full tool name).
   * Used to fail-fast after repeated retries of the same omitted tool.
   */
  mcpNotInCatalogCounts?: Map<string, number>
  /** Paths the agent changed this run — scopes git_commit staging when present. */
  mutationPaths?: Set<string>
  /**
   * Parent tool-approval gate.
   */
  approval?: ToolApprovalGate
}

type ToolHandler = (
  workspace: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  context: ToolExecutionContext
) => Promise<ToolResult> | ToolResult

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

function logToolSuccess(name: string): void {
  logger.info('Tool succeeded', {
    scope: 'tools',
    tool: name
  })
}

function toolOk(name: string, summary: string, content: string): ToolResult {
  logToolSuccess(name)
  return { ok: true, summary, content }
}

function toolFail(
  name: string,
  summary: string,
  content: string,
  opts?: { failureLogged?: boolean }
): ToolResult {
  return { ok: false, summary, content, failureLogged: opts?.failureLogged }
}

function logToolFailure(name: string, err: unknown): void {
  const fields: {
    scope: 'tools'
    code: 'TOOL_EXEC'
    tool: string
    err: unknown
    kind?: string
  } = {
    scope: 'tools',
    code: 'TOOL_EXEC',
    tool: name,
    err
  }
  const kind = toolFailureKind(err)
  if (kind) fields.kind = kind
  const summary = logErrorSummary(err, 'TOOL_EXEC')
  const line = kind
    ? `Tool execution failed: ${summary} (${kind})`
    : `Tool execution failed: ${summary}`
  if (isExpectedToolError(formatError(err))) {
    logger.warn(line, fields)
  } else {
    logger.error(line, fields)
  }
}

/** Stable, path-free classifier for tool failures (safe for structured logs). */
function toolFailureKind(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const message = err.message ?? ''
  if (/^File not found/i.test(message)) return 'not_found'
  if (/^Not a file/i.test(message)) return 'not_a_file'
  if (/Path is a directory/i.test(message)) return 'is_directory'
  if (/Binary file detected/i.test(message)) return 'binary'
  if (/File too large/i.test(message)) return 'too_large'
  if (/Path escapes workspace/i.test(message)) return 'path_escape'
  if (/Failed to parse tool arguments/i.test(message)) return 'bad_args'
  if (err.name === 'AbortError') return 'aborted'
  const code = (err as Error & { code?: unknown }).code
  if (typeof code === 'string') return code
  return undefined
}

export function terminalResultOk(command: string, content: string): boolean {
  // Background session frames: in-progress statuses are a healthy session, not
  // a failure — the placeholder `exit_code: -1` would otherwise fail them.
  const sessionStatus = /^status: (\w+)/m.exec(content)?.[1]
  if (sessionStatus === 'running' || sessionStatus === 'timeout' || sessionStatus === 'pattern_matched') {
    return true
  }
  if (!content.includes('exit_code: ')) return true
  if (/exit_code: 0\b/.test(content)) return true
  // Soft-success helpers are cmd-oriented only.
  const shellLine = /^shell:\s*(\S+)/m.exec(content)
  const shell = shellLine?.[1]
  if (shell && shell !== 'cmd') return false
  if (isFindstrNoMatchContent(command, content)) return true
  return isDirMissingPathContent(command, content)
}

function resolveAgentMode(context: ToolExecutionContext): AgentInteractionMode {
  return context.getAgentMode?.() ?? context.agentMode ?? 'agent'
}

/** Drop short-lived FS views that mutate with writes/git (git status, snapshot, gitignore). */
function invalidateAfterWorkspaceMutation(workspace: string): void {
  invalidateGitStatusCache(workspace)
  clearWorkspaceSnapshotCache(workspace)
  clearGitignoreMatcherCache(workspace)
}

type CheckpointWatchContext = { runDir?: string; skipWriteCheckpoint?: boolean }

/** Snapshot known + opaque terminal writes for undo. */
async function withTerminalCheckpointWatch<T>(
  workspace: string,
  command: string,
  context: CheckpointWatchContext,
  run: () => Promise<T>
): Promise<T> {
  recordTerminalCommandPriors(workspace, command, context)
  const snap =
    !context.skipWriteCheckpoint && context.runDir && command.trim() && needsOpaqueWatch(command)
      ? startWatch(workspace)
      : null
  try {
    return await run()
  } finally {
    if (snap) {
      applyWatchDiffToCheckpoint(snap, diffSince(snap), context)
      disposeWatch(snap)
    }
  }
}

function optionalMcpServerId(args: Record<string, unknown>): string | undefined {
  const value = args.serverId ?? args.server_id
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function mcpServerGate(
  toolName: string,
  serverId: string,
  summary: string,
  context: ToolExecutionContext,
  workspacePath?: string | null
): { ok: true } | { ok: false; result: ToolResult } {
  const access = assertMcpServerAccess(serverId, context.runEnabledMcpIds, workspacePath)
  if (!access.ok) {
    return { ok: false, result: toolFail(toolName, summary, access.error) }
  }
  return { ok: true }
}

function formatMcpResourceLines(entries: Awaited<ReturnType<typeof listMcpResources>>): string {
  return entries
    .map((entry) => {
      const label = entry.name ? `${entry.uri} (${entry.name})` : entry.uri
      const meta = [entry.mimeType, entry.description?.replace(/\s+/g, ' ').trim()]
        .filter(Boolean)
        .join(' — ')
      return `- [${entry.serverId}] ${label}${meta ? `: ${meta}` : ''}`
    })
    .join('\n')
}

function formatMcpPromptLines(entries: Awaited<ReturnType<typeof listMcpPrompts>>): string {
  return entries
    .map((entry) => {
      const argNames = (entry.arguments ?? []).map((arg) => arg.name).filter(Boolean)
      const argsNote = argNames.length ? ` args=[${argNames.join(', ')}]` : ''
      const desc = entry.description?.replace(/\s+/g, ' ').trim()
      return `- [${entry.serverId}] ${entry.name}${argsNote}${desc ? `: ${desc}` : ''}`
    })
    .join('\n')
}

const BUILTIN_HANDLERS: Record<AgentToolName, ToolHandler> = {
  read: (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = String(args.path ?? '')
    const offset = typeof args.offset === 'number' ? args.offset : undefined
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    const startLine = typeof args.startLine === 'number' ? args.startLine : undefined
    const endLine = typeof args.endLine === 'number' ? args.endLine : undefined
    const content = toolRead(workspace, path, { offset, limit, startLine, endLine })
    throwIfAborted(signal)
    return toolOk('read', path, content.slice(0, READ_CONTENT_CAP))
  },
  edit: (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const path = String(args.path ?? '')
    if (!context.skipWriteCheckpoint) {
      getWriteCheckpoint(context.runDir)?.recordPrior(path, 'write')
    }
    const contents = typeof args.contents === 'string' ? args.contents : undefined
    const diff = typeof args.diff === 'string' ? args.diff : undefined
    const content = toolEdit(workspace, path, contents, diff)
    invalidateAfterWorkspaceMutation(workspace)
    return toolOk('edit', path, content)
  },
  search: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const query = String(args.query ?? '')
    const maxResults =
      typeof args.maxResults === 'number' ? args.maxResults : SEARCH_DEFAULT_MAX_RESULTS
    const regex = args.regex === true
    const content = await toolSearch(workspace, query, maxResults, signal, regex)
    throwIfAborted(signal)
    return toolOk('search', query, content)
  },
  glob: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const pattern = String(args.pattern ?? '')
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : undefined
    const content = await toolGlob(workspace, pattern, maxResults, signal)
    throwIfAborted(signal)
    return toolOk('glob', pattern, content)
  },
  grep: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const pattern = String(args.pattern ?? '')
    const content = await toolGrep(
      workspace,
      pattern,
      {
        include: typeof args.include === 'string' ? args.include : undefined,
        caseSensitive: args.caseSensitive === true,
        contextLines: typeof args.contextLines === 'number' ? args.contextLines : undefined,
        maxResults: typeof args.maxResults === 'number' ? args.maxResults : undefined
      },
      signal
    )
    throwIfAborted(signal)
    return toolOk('grep', pattern, content)
  },
  list_dir: (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
    return toolOk('list_dir', path, toolListDir(workspace, path))
  },
  multi_edit: (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const edits = (Array.isArray(args.edits) ? args.edits : []) as MultiEditEntry[]
    if (!context.skipWriteCheckpoint) {
      const cp = getWriteCheckpoint(context.runDir)
      if (cp) {
        for (const edit of edits) {
          if (typeof edit.path === 'string' && edit.path.trim()) {
            cp.recordPrior(edit.path, 'write')
          }
        }
      }
    }
    const content = toolMultiEdit(workspace, edits, signal)
    invalidateAfterWorkspaceMutation(workspace)
    // Unique-path count, normalized like the schema's duplicate check.
    const uniquePaths = new Set(
      edits
        .map((edit) => (typeof edit.path === 'string' ? edit.path.trim() : ''))
        .filter(Boolean)
        .map((path) => path.replace(/\\/g, '/').toLowerCase())
    )
    return toolOk('multi_edit', `${uniquePaths.size} files`, content)
  },
  str_replace: (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const path = String(args.path ?? '')
    if (!context.skipWriteCheckpoint) {
      getWriteCheckpoint(context.runDir)?.recordPrior(path, 'write')
    }
    const content = toolStrReplace(
      workspace,
      path,
      String(args.old_string ?? ''),
      typeof args.new_string === 'string' ? args.new_string : '',
      args.replace_all === true
    )
    invalidateAfterWorkspaceMutation(workspace)
    return toolOk('str_replace', path, content)
  },
  delete: (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const path = String(args.path ?? '')
    const recursive = args.recursive === true
    if (!context.skipWriteCheckpoint) {
      getWriteCheckpoint(context.runDir)?.recordPrior(path, 'delete', { recursiveDir: recursive })
    }
    const content = toolDelete(workspace, path, recursive)
    invalidateAfterWorkspaceMutation(workspace)
    return toolOk('delete', path, content)
  },
  todo_write: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const todos = (Array.isArray(args.todos) ? args.todos : []) as TodoItem[]
    const { content } = toolTodoWrite(context.runDir ?? '', todos, args.merge === true)
    return toolOk('todo_write', `${todos.length} tasks`, content)
  },
  browser_search: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const query = String(args.query ?? '').trim()
    if (!query) {
      return toolFail('browser_search', 'search', 'query is required')
    }
    const settings = getSettings()
    const url = buildSearchUrl(settings.searchEngine, query)
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
    const { navigateUrl, snapshotPage } = await import('@main/app/agentBrowser')
    const nav = await navigateUrl(url, { signal, timeoutMs, workspacePath: workspace })
    throwIfAborted(signal)
    const snap = await snapshotPage({
      signal,
      workspacePath: workspace,
      runDir: context.runDir,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined
    })
    throwIfAborted(signal)
    return toolOk('browser_search', query, `${nav}\n\n${snap}`)
  },
  browser_navigate: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const url = String(args.url ?? '')
    const { navigateUrl } = await import('@main/app/agentBrowser')
    const content = await navigateUrl(url, {
      signal,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_navigate', url, content)
  },
  browser_snapshot: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const { snapshotPage } = await import('@main/app/agentBrowser')
    const content = await snapshotPage({
      signal,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
      runDir: context.runDir,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_snapshot', 'page', content)
  },
  browser_click: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const selector = String(args.selector ?? '')
    const { clickSelector } = await import('@main/app/agentBrowser')
    const button =
      args.button === 'left' || args.button === 'right' || args.button === 'middle'
        ? args.button
        : undefined
    const content = await clickSelector(selector, {
      signal,
      button,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_click', selector, content)
  },
  browser_type: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const text = String(args.text ?? '')
    const { typeText } = await import('@main/app/agentBrowser')
    const content = await typeText(text, {
      signal,
      selector: typeof args.selector === 'string' ? args.selector : undefined,
      clear: args.clear === true,
      pressEnter: args.pressEnter === true,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    const target =
      typeof args.selector === 'string' && args.selector.trim()
        ? args.selector.trim()
        : 'active element'
    return toolOk('browser_type', target, content)
  },
  browser_scroll: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const { scrollPage } = await import('@main/app/agentBrowser')
    const content = await scrollPage({
      signal,
      selector: typeof args.selector === 'string' ? args.selector : undefined,
      deltaX: typeof args.deltaX === 'number' ? args.deltaX : undefined,
      deltaY: typeof args.deltaY === 'number' ? args.deltaY : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    const target =
      typeof args.selector === 'string' && args.selector.trim()
        ? args.selector.trim()
        : `Δ(${Number(args.deltaX) || 0},${Number(args.deltaY) || 0})`
    return toolOk('browser_scroll', target, content)
  },
  browser_fill: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const selector = String(args.selector ?? '')
    const value = String(args.value ?? '')
    const { fillSelector } = await import('@main/app/agentBrowser')
    const content = await fillSelector(selector, value, {
      signal,
      pressEnter: args.pressEnter === true,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_fill', selector, content)
  },
  browser_tabs: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const action = args.action
    if (action !== 'list' && action !== 'open' && action !== 'close' && action !== 'select') {
      return toolFail('browser_tabs', 'tabs', 'action must be list|open|close|select')
    }
    const { manageTabs } = await import('@main/app/agentBrowser')
    const content = await manageTabs(action, {
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      url: typeof args.url === 'string' ? args.url : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_tabs', action, content)
  },
  browser_back: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const { goBack } = await import('@main/app/agentBrowser')
    const content = await goBack({
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_back', 'back', content)
  },
  browser_forward: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const { goForward } = await import('@main/app/agentBrowser')
    const content = await goForward({
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_forward', 'forward', content)
  },
  browser_wait_for_selector: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const selector = String(args.selector ?? '')
    const { waitForSelector } = await import('@main/app/agentBrowser')
    const content = await waitForSelector(selector, {
      signal,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_wait_for_selector', selector, content)
  },
  browser_wait_for_url: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const match = String(args.match ?? '')
    const { waitForUrl } = await import('@main/app/agentBrowser')
    const content = await waitForUrl(match, {
      signal,
      regex: args.regex === true,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_wait_for_url', match.slice(0, 80), content)
  },
  browser_press_key: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const key = String(args.key ?? '')
    const { pressKey } = await import('@main/app/agentBrowser')
    const modifiers = Array.isArray(args.modifiers)
      ? args.modifiers.filter((m): m is string => typeof m === 'string')
      : undefined
    const content = await pressKey(key, {
      signal,
      modifiers,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_press_key', key, content)
  },
  browser_select_option: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const selector = String(args.selector ?? '')
    const { selectOption } = await import('@main/app/agentBrowser')
    const content = await selectOption(selector, {
      signal,
      value: typeof args.value === 'string' ? args.value : undefined,
      label: typeof args.label === 'string' ? args.label : undefined,
      pressEnter: args.pressEnter === true,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_select_option', selector, content)
  },
  mcp_list_tools: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const filter = optionalMcpServerId(args)?.toLowerCase() ?? ''
    const enabled = context.runEnabledMcpIds
    const stepCatalog = context.stepMcpToolNames
    const defs = listMcpToolDefinitions().filter((t) => {
      const parsed = parseMcpToolName(t.name)
      if (!parsed) return false
      if (filter && parsed.serverId.toLowerCase() !== filter) return false
      if (enabled && !enabled.has(parsed.serverId)) return false
      return true
    })
    if (defs.length === 0) {
      const statuses = getMcpServerStatus(resolveEffectiveMcpServers()).filter((s) => {
        if (!s.enabled) return false
        if (enabled && !enabled.has(s.id)) return false
        if (filter && s.id.toLowerCase() !== filter) return false
        return true
      })
      const down = statuses.filter((s) => !s.connected)
      if (down.length > 0) {
        const lines = down.map(
          (s) => `- ${s.id}${s.error ? `: ${s.error}` : ': not connected'}`
        )
        return toolFail(
          'mcp_list_tools',
          filter || 'mcp',
          [
            'Enabled MCP server(s) are configured but not connected:',
            ...lines,
            '',
            'Fix in Settings → Marketplace (ensure uv/uvx is on PATH), then Refresh MCP connections.'
          ].join('\n')
        )
      }
      return toolOk(
        'mcp_list_tools',
        filter || 'mcp',
        filter ? `No MCP tools matching serverId=${filter}` : 'No MCP tools connected.'
      )
    }
    const lines = defs.map((t) => {
      const hint = getMcpReadOnlyHint(t.name)
      const hintNote =
        hint === true ? ' readOnlyHint=true' : hint === false ? ' readOnlyHint=false' : ''
      const omitted =
        stepCatalog && !stepCatalog.has(t.name) ? ' [omitted from this step catalog]' : ''
      const desc = (t.description || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      return `- ${t.name}${hintNote}${omitted}${desc ? `: ${desc}` : ''}`
    })
    return toolOk('mcp_list_tools', `${defs.length} tools`, lines.join('\n'))
  },
  request_mcp_tools: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const pinned = context.runPinnedMcpToolNames
    if (!pinned) {
      return toolFail(
        'request_mcp_tools',
        'pin',
        'request_mcp_tools requires an active agent run.'
      )
    }
    const serverId =
      (typeof args.serverId === 'string' && args.serverId.trim()) ||
      (typeof args.server_id === 'string' && args.server_id.trim()) ||
      ''
    const requested = Array.isArray(args.tools)
      ? args.tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : []
    if (!serverId && requested.length === 0) {
      return toolFail(
        'request_mcp_tools',
        'pin',
        'Provide tools: string[] and/or serverId to pin MCP tools for the next step.'
      )
    }
    const enabled = context.runEnabledMcpIds
    const connected = listMcpToolDefinitions().filter((t) => {
      const parsed = parseMcpToolName(t.name)
      if (!parsed) return false
      if (enabled && !enabled.has(parsed.serverId)) return false
      return true
    })
    const byFull = new Map(connected.map((t) => [t.name, t]))
    const byBare = new Map<string, string[]>()
    for (const t of connected) {
      const parsed = parseMcpToolName(t.name)
      if (!parsed) continue
      const list = byBare.get(parsed.toolName) ?? []
      list.push(t.name)
      byBare.set(parsed.toolName, list)
    }

    const newlyPinned: string[] = []
    const unknown: string[] = []
    const already: string[] = []

    if (serverId) {
      const fromServer = connected.filter((t) => {
        const parsed = parseMcpToolName(t.name)
        return parsed?.serverId.toLowerCase() === serverId.toLowerCase()
      })
      if (fromServer.length === 0) {
        return toolFail(
          'request_mcp_tools',
          serverId,
          `No connected MCP tools for serverId=${serverId}.`
        )
      }
      for (const t of fromServer) {
        if (pinned.has(t.name)) already.push(t.name)
        else {
          pinned.add(t.name)
          newlyPinned.push(t.name)
        }
      }
    }

    for (const raw of requested) {
      const name = raw.trim()
      if (byFull.has(name)) {
        if (pinned.has(name)) already.push(name)
        else {
          pinned.add(name)
          newlyPinned.push(name)
        }
        continue
      }
      const bareMatches = byBare.get(name) ?? []
      if (bareMatches.length === 1) {
        const full = bareMatches[0]!
        if (pinned.has(full)) already.push(full)
        else {
          pinned.add(full)
          newlyPinned.push(full)
        }
        continue
      }
      if (bareMatches.length > 1) {
        unknown.push(`${name} (ambiguous: ${bareMatches.join(', ')})`)
        continue
      }
      unknown.push(name)
    }

    if (newlyPinned.length > 0) {
      const stamp = Math.max(context.currentStep ?? 1, 1)
      const lastUsed = context.mcpLastUsedByName
      if (lastUsed) {
        for (const name of newlyPinned) lastUsed.set(name, stamp)
      }
      context.invalidateMcpToolCatalogCache?.()
    }

    const lines = [
      newlyPinned.length
        ? `Pinned for next step (${newlyPinned.length}): ${newlyPinned.join(', ')}`
        : 'No new tools pinned.',
      already.length ? `Already pinned: ${already.join(', ')}` : '',
      unknown.length ? `Unknown / unresolved: ${unknown.join(', ')}` : '',
      'Definitions are append-admitted into the sticky catalog on the next model step (prior tool order kept). Idle pins may later unload (TTL / soft max); call release_mcp_tools when done.'
    ].filter(Boolean)
    return toolOk(
      'request_mcp_tools',
      `${newlyPinned.length} pinned`,
      lines.join('\n')
    )
  },
  release_mcp_tools: (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const pinned = context.runPinnedMcpToolNames
    if (!pinned) {
      return toolFail(
        'release_mcp_tools',
        'release',
        'release_mcp_tools requires an active agent run.'
      )
    }
    const serverId =
      (typeof args.serverId === 'string' && args.serverId.trim()) ||
      (typeof args.server_id === 'string' && args.server_id.trim()) ||
      ''
    const requested = Array.isArray(args.tools)
      ? args.tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : []
    if (!serverId && requested.length === 0) {
      return toolFail(
        'release_mcp_tools',
        'release',
        'Provide tools: string[] and/or serverId to release pinned MCP tools.'
      )
    }

    const toRelease = new Set<string>()
    const unknown: string[] = []

    if (serverId) {
      const needle = serverId.toLowerCase()
      let found = 0
      for (const name of pinned) {
        const parsed = parseMcpToolName(name)
        if (parsed?.serverId.toLowerCase() === needle) {
          toRelease.add(name)
          found++
        }
      }
      if (found === 0) {
        return toolFail(
          'release_mcp_tools',
          serverId,
          `No pinned MCP tools for serverId=${serverId}.`
        )
      }
    }

    for (const raw of requested) {
      const name = raw.trim()
      if (pinned.has(name) || toRelease.has(name)) {
        toRelease.add(name)
        continue
      }
      const bareMatches = [...pinned].filter((full) => {
        const parsed = parseMcpToolName(full)
        return parsed?.toolName === name
      })
      if (bareMatches.length === 1) {
        toRelease.add(bareMatches[0]!)
        continue
      }
      if (bareMatches.length > 1) {
        unknown.push(`${name} (ambiguous: ${bareMatches.join(', ')})`)
        continue
      }
      unknown.push(name)
    }

    const released: string[] = []
    for (const name of toRelease) {
      if (!pinned.has(name)) continue
      pinned.delete(name)
      context.mcpLastUsedByName?.delete(name)
      released.push(name)
    }

    if (released.length > 0) context.invalidateMcpToolCatalogCache?.()

    const lines = [
      released.length
        ? `Released (${released.length}): ${released.join(', ')}`
        : 'No pinned tools released.',
      unknown.length ? `Unknown / unresolved: ${unknown.join(', ')}` : '',
      'Schemas drop from the sticky catalog on the next model step. Re-pin with request_mcp_tools if needed.'
    ].filter(Boolean)
    return toolOk(
      'release_mcp_tools',
      `${released.length} released`,
      lines.join('\n')
    )
  },
  mcp_list_resources: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = optionalMcpServerId(args)
    if (serverId) {
      const gate = mcpServerGate('mcp_list_resources', serverId, serverId, context, workspace)
      if (!gate.ok) return gate.result
    }
    const entries = await listMcpResources(
      serverId,
      context.runEnabledMcpIds,
      signal,
      workspace
    )
    if (entries.length === 0) {
      return toolOk(
        'mcp_list_resources',
        serverId || 'mcp',
        serverId ? `No MCP resources for server ${serverId}` : 'No MCP resources connected.'
      )
    }
    return toolOk(
      'mcp_list_resources',
      `${entries.length} resources`,
      formatMcpResourceLines(entries)
    )
  },
  mcp_read_resource: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = String(args.serverId ?? '').trim()
    const uri = String(args.uri ?? '').trim()
    if (!serverId) return toolFail('mcp_read_resource', uri || 'resource', 'serverId is required')
    if (!uri) return toolFail('mcp_read_resource', serverId, 'uri is required')
    const gate = mcpServerGate('mcp_read_resource', serverId, uri, context, workspace)
    if (!gate.ok) return gate.result
    const result = await readMcpResource(
      serverId,
      uri,
      signal,
      context.runEnabledMcpIds,
      workspace
    )
    if (!result.ok) return toolFail('mcp_read_resource', uri, result.error)
    return toolOk('mcp_read_resource', uri, result.content)
  },
  mcp_list_prompts: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = optionalMcpServerId(args)
    if (serverId) {
      const gate = mcpServerGate('mcp_list_prompts', serverId, serverId, context, workspace)
      if (!gate.ok) return gate.result
    }
    const entries = await listMcpPrompts(
      serverId,
      context.runEnabledMcpIds,
      signal,
      workspace
    )
    if (entries.length === 0) {
      return toolOk(
        'mcp_list_prompts',
        serverId || 'mcp',
        serverId ? `No MCP prompts for server ${serverId}` : 'No MCP prompts connected.'
      )
    }
    return toolOk('mcp_list_prompts', `${entries.length} prompts`, formatMcpPromptLines(entries))
  },
  mcp_get_prompt: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const serverId = String(args.serverId ?? '').trim()
    const name = String(args.name ?? '').trim()
    if (!serverId) return toolFail('mcp_get_prompt', name || 'prompt', 'serverId is required')
    if (!name) return toolFail('mcp_get_prompt', serverId, 'name is required')
    const gate = mcpServerGate('mcp_get_prompt', serverId, name, context, workspace)
    if (!gate.ok) return gate.result
    const promptArgs =
      args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? Object.fromEntries(
            Object.entries(args.arguments).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : undefined
    const result = await getMcpPrompt(
      serverId,
      name,
      promptArgs,
      signal,
      context.runEnabledMcpIds,
      workspace
    )
    if (!result.ok) return toolFail('mcp_get_prompt', name, result.error)
    return toolOk('mcp_get_prompt', name, result.content)
  },
  ask_question: async (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    const normalized = normalizeAskQuestionArgs(args as Record<string, unknown>)
    if (!normalized.ok) {
      return toolFail(
        'ask_question',
        'invalid question',
        `${normalized.error} Fix the question payload (title/options) and call ask_question again - this is not a user dismissal.`
      )
    }
    const { form } = normalized
    const summary = askQuestionSummary(form)
    if (!context.runId || !context.toolCallId) {
      return toolFail('ask_question', summary, 'ask_question requires an active run')
    }
    const request: AgentQuestionRequest = {
      requestId: randomUUID(),
      runId: context.runId,
      toolCallId: context.toolCallId,
      ...(form.title ? { title: form.title } : {}),
      questions: form.questions
    }
    const ask =
      context.askQuestion ??
      ((req, sig) => askQuestionThroughRenderer(req, sig, context.invokeId))
    try {
      const answers = await ask(request, signal)
      if (answers.length === 0) {
        return toolFail(
          'ask_question',
          summary,
          'Question timed out or was dismissed without answers. Continue with a reasonable default, or ask again with a shorter question.'
        )
      }
      return toolOk('ask_question', summary, formatQuestionAnswers(form, answers))
    } catch (err) {
      if (isAbortError(err)) throw err
      const message = err instanceof Error ? err.message : 'Question failed'
      return toolFail(
        'ask_question',
        summary,
        /window is listening|none is listening/i.test(message)
          ? `${message} This is transient - retry ask_question once the UI is ready.`
          : message
      )
    }
  },
  switch_mode: async (_workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.autoModeSwitch) {
      return toolFail(
        'switch_mode',
        'mode',
        'Automatic mode switching is off. Only the user can change Ask / Plan / Agent (composer or slash).'
      )
    }
    const mode = args.mode
    if (mode !== 'ask' && mode !== 'plan' && mode !== 'agent') {
      return toolFail('switch_mode', 'mode', 'mode must be ask, plan, or agent')
    }
    const previous = resolveAgentMode(context)
    if (!context.setAgentMode) {
      return toolFail(
        'switch_mode',
        'mode',
        'Mode switch unavailable: setAgentMode is not wired for this invoke.'
      )
    }
    await context.setAgentMode(mode)
    if (context.runId) {
      context.emitAgentEvent?.({
        type: 'mode_changed',
        runId: context.runId,
        mode,
        ...(context.invokeId != null ? { invokeId: context.invokeId } : {})
      })
    }
    const content =
      previous === mode
        ? `Already in ${mode} mode.`
        : `Mode switched from ${previous} to ${mode}. Tool availability updated for subsequent steps.`
    return toolOk('switch_mode', mode, content)
  },
  terminal: async (workspace, args, signal, context) => {
    const command = typeof args.command === 'string' ? args.command : ''
    // Command present: ignore session_id (including invented UUIDs) and run the command.
    const sessionId =
      command.trim()
        ? ''
        : typeof args.session_id === 'string' && args.session_id.trim()
          ? args.session_id.trim()
          : ''
    const shell = context.terminalShell ?? getSettings().terminalShell ?? 'auto'
    const pattern = typeof args.pattern === 'string' ? args.pattern : undefined
    const useSessionApi = Boolean(sessionId) || typeof args.block_until_ms === 'number'
    const onOutput = context.onTerminalOutput
    const workingDirectory =
      typeof args.working_directory === 'string' && args.working_directory.trim()
        ? args.working_directory.trim()
        : ''
    const cwd = workingDirectory
      ? resolveInsideWorkspace(workspace, workingDirectory)
      : workspace

    if (useSessionApi) {
      const runId = context.runId
      const invokeId = context.invokeId
      if (!runId || !invokeId) {
        return toolFail('terminal', 'session', 'Background terminal requires run ownership')
      }
      const { startBackgroundTerminal, pollTerminalSession } = await import('./terminalSessions')
      const blockUntilMs =
        typeof args.block_until_ms === 'number' ? args.block_until_ms : sessionId ? 30_000 : 0
      const watchCtx: CheckpointWatchContext = {
        runDir: context.runDir,
        skipWriteCheckpoint: context.skipWriteCheckpoint
      }
      const content = sessionId
        ? await pollTerminalSession({
            runId,
            invokeId,
            sessionId,
            blockUntilMs,
            pattern,
            signal,
            runSignal: context.runSignal,
            onOutput
          })
        : await withTerminalCheckpointWatch(workspace, command, watchCtx, () =>
            startBackgroundTerminal({
              runId,
              invokeId,
              workspaceRoot: workspace,
              cwd,
              command,
              signal,
              shell,
              pattern,
              blockUntilMs,
              onOutput
            })
          )
      // New background command may mutate the tree; pure session polls do not.
      if (!sessionId) {
        invalidateAfterWorkspaceMutation(workspace)
      }
      const summary = (command || sessionId).slice(0, 80)
      const ok = terminalResultOk(command || 'session', content)
      if (ok) return toolOk('terminal', summary, content)
      return toolFail('terminal', summary, content)
    }

    const requested = typeof args.timeoutMs === 'number' ? args.timeoutMs : 60_000
    const timeoutMs = Math.min(TERMINAL_MAX_TIMEOUT_MS, Math.max(1, requested))
    const watchCtx: CheckpointWatchContext = {
      runDir: context.runDir,
      skipWriteCheckpoint: context.skipWriteCheckpoint
    }
    const content = await withTerminalCheckpointWatch(workspace, command, watchCtx, () =>
      toolTerminal(workspace, command, signal, {
        timeoutMs,
        shell,
        cwd,
        onOutput
      })
    )
    invalidateAfterWorkspaceMutation(workspace)
    const summary = command.slice(0, 80)
    const ok = terminalResultOk(command, content)
    if (ok) return toolOk('terminal', summary, content)
    return toolFail('terminal', summary, content)
  },
  memory_list: (workspace, _args, signal) => {
    throwIfAborted(signal)
    return toolOk('memory_list', 'memory', toolMemoryList(workspace))
  },
  memory_read: (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = String(args.path ?? '')
    const content = toolMemoryRead(workspace, path)
    return toolOk('memory_read', path, content.slice(0, READ_CONTENT_CAP))
  },
  memory_write: (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = String(args.path ?? '')
    const contents = typeof args.contents === 'string' ? args.contents : ''
    const content = toolMemoryWrite(workspace, path, contents)
    clearWorkspaceSnapshotCache(workspace)
    return toolOk('memory_write', path, content)
  },
  Skill: (workspace, args, signal) => {
    throwIfAborted(signal)
    const name = String(args.name ?? '')
    const path = typeof args.path === 'string' ? args.path : undefined
    try {
      const content = toolSkill(workspace, name, path)
      return toolOk('Skill', summarizeSkillArgs(name, path), content.slice(0, READ_CONTENT_CAP))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('Skill', summarizeSkillArgs(name, path), msg)
    }
  },
  git_status: async (workspace, _args, signal) => {
    throwIfAborted(signal)
    const content = await toolGitStatusAsync(workspace)
    throwIfAborted(signal)
    return toolOk('git_status', 'git status', content)
  },
  git_diff: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = typeof args.path === 'string' ? args.path : undefined
    const staged = args.staged === true
    const result = await toolGitDiffAsync(workspace, { path, staged })
    throwIfAborted(signal)
    const summary = path ? `git diff ${path}` : staged ? 'git diff --staged' : 'git diff'
    // Match git_status: non-repo is informative ok content, not a hard tool failure.
    if (!result.ok && result.content === 'Not a git repository') {
      return toolOk('git_diff', summary, result.content)
    }
    if (!result.ok) return toolFail('git_diff', summary, result.content)
    return toolOk('git_diff', summary, result.content)
  },
  git_commit: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const message = String(args.message ?? '').trim()
    if (!message) return toolFail('git_commit', 'git commit', 'Commit message is required')
    const push = args.push === true
    const extraPaths = Array.isArray(args.paths)
      ? args.paths.filter((p): p is string => typeof p === 'string')
      : []
    try {
      // Scope staging to files this run actually changed (plus any paths the
      // model names explicitly) so unrelated user edits are not swept into
      // the commit. Without tracked mutations, fall back to staging all.
      const touched = new Set<string>([...(context.mutationPaths ?? []), ...extraPaths])
      const summary = push ? 'git commit + push' : 'git commit'
      const lines: string[] = []
      let committed = false
      let pushed = false
      if (touched.size > 0) {
        const outcome = await commitPaths(workspace, message, push, [...touched])
        committed = outcome.committed
        pushed = outcome.pushed
        lines.push(
          outcome.detail,
          `committed: ${outcome.committed}`,
          `pushed: ${outcome.pushed}`,
          `message: ${message}`
        )
        if (outcome.skipped.length > 0) {
          const shown = outcome.skipped.slice(0, 20)
          const more = outcome.skipped.length - shown.length
          lines.push(
            `left uncommitted (${outcome.skipped.length} unrelated dirty path${outcome.skipped.length === 1 ? '' : 's'}): ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`,
            'To include any of these, call git_commit again with paths: [...].'
          )
        }
      } else {
        const outcome = await commitAll(workspace, message, push)
        committed = outcome.committed
        pushed = outcome.pushed
        lines.push(
          outcome.detail,
          `committed: ${outcome.committed}`,
          `pushed: ${outcome.pushed}`,
          `message: ${message}`
        )
      }
      if (committed) invalidateAfterWorkspaceMutation(workspace)
      return toolOk('git_commit', summary, lines.join('\n'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('git_commit', 'git commit', msg)
    }
  },
  diagnostics: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const kind = args.kind === 'lint' ? 'lint' : 'typecheck'
    const result = await toolDiagnosticsAsync(
      workspace,
      kind,
      signal,
      context.diagnosticsCommand
    )
    throwIfAborted(signal)
    if (!result.ok) return toolFail('diagnostics', kind, result.content)
    return toolOk('diagnostics', kind, result.content)
  },
  generate_image: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const agentMode = resolveAgentMode(context)
    const result = await toolGenerateImage(
      workspace,
      {
        prompt: String(args.prompt ?? ''),
        path: typeof args.path === 'string' ? args.path : undefined,
        provider: typeof args.provider === 'string' ? args.provider : undefined,
        model: typeof args.model === 'string' ? args.model : undefined,
        size: typeof args.size === 'string' ? args.size : undefined,
        quality:
          args.quality === 'low' ||
          args.quality === 'medium' ||
          args.quality === 'high' ||
          args.quality === 'auto'
            ? args.quality
            : undefined,
        aspect_ratio: typeof args.aspect_ratio === 'string' ? args.aspect_ratio : undefined,
        resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
        preset: args.preset === 'draft' || args.preset === 'final' ? args.preset : undefined,
        n: typeof args.n === 'number' && Number.isFinite(args.n) ? args.n : undefined,
        output_format: normalizeOutputFormat(
          typeof args.output_format === 'string' ? args.output_format : undefined
        ),
        output_compression:
          typeof args.output_compression === 'number' && Number.isFinite(args.output_compression)
            ? args.output_compression
            : undefined,
        background:
          args.background === 'opaque' ||
          args.background === 'transparent' ||
          args.background === 'auto'
            ? args.background
            : undefined
      },
      {
        agentMode,
        signal,
        runDir: context.runDir,
        skipWriteCheckpoint: context.skipWriteCheckpoint,
        onProgress: context.onProgress,
        settings: context.imageToolSettings
      }
    )
    throwIfAborted(signal)
    if (!result.ok) return toolFail('generate_image', result.summary, result.content)
    if (agentMode === 'agent') {
      invalidateAfterWorkspaceMutation(workspace)
    }
    return toolOk('generate_image', result.summary, result.content)
  },
  edit_image: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const agentMode = resolveAgentMode(context)
    const refs = Array.isArray(args.reference_paths)
      ? args.reference_paths.map((p) => String(p ?? ''))
      : []
    const result = await toolEditImage(
      workspace,
      {
        prompt: String(args.prompt ?? ''),
        reference_paths: refs,
        path: typeof args.path === 'string' ? args.path : undefined,
        mask_path: typeof args.mask_path === 'string' ? args.mask_path : undefined,
        provider: typeof args.provider === 'string' ? args.provider : undefined,
        model: typeof args.model === 'string' ? args.model : undefined,
        size: typeof args.size === 'string' ? args.size : undefined,
        quality:
          args.quality === 'low' ||
          args.quality === 'medium' ||
          args.quality === 'high' ||
          args.quality === 'auto'
            ? args.quality
            : undefined,
        aspect_ratio: typeof args.aspect_ratio === 'string' ? args.aspect_ratio : undefined,
        resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
        preset: args.preset === 'draft' || args.preset === 'final' ? args.preset : undefined,
        n: typeof args.n === 'number' && Number.isFinite(args.n) ? args.n : undefined,
        output_format: normalizeOutputFormat(
          typeof args.output_format === 'string' ? args.output_format : undefined
        ),
        output_compression:
          typeof args.output_compression === 'number' && Number.isFinite(args.output_compression)
            ? args.output_compression
            : undefined,
        background:
          args.background === 'opaque' ||
          args.background === 'transparent' ||
          args.background === 'auto'
            ? args.background
            : undefined
      },
      {
        agentMode,
        signal,
        runDir: context.runDir,
        skipWriteCheckpoint: context.skipWriteCheckpoint,
        onProgress: context.onProgress,
        settings: context.imageToolSettings
      }
    )
    throwIfAborted(signal)
    if (!result.ok) return toolFail('edit_image', result.summary, result.content)
    if (agentMode === 'agent') {
      invalidateAfterWorkspaceMutation(workspace)
    }
    return toolOk('edit_image', result.summary, result.content)
  }
}

export const BUILTIN_TOOL_NAMES = Object.keys(BUILTIN_HANDLERS) as AgentToolName[]

export async function executeTool(
  name: string,
  argsJson: string,
  workspace: string,
  signal: AbortSignal,
  context: ToolExecutionContext = {}
): Promise<ToolResult> {
  throwIfAborted(signal)

  const agentMode: AgentInteractionMode = resolveAgentMode(context)

  const mcp = parseMcpToolName(name)
  if (mcp) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(argsJson || '{}') as Record<string, unknown>
    } catch {
      return toolFail(name, name, 'Failed to parse tool arguments JSON')
    }
    const modeGate = assertToolAllowedInMode(agentMode, name, parsed, {
      autoModeSwitch: context.autoModeSwitch
    })
    if (!modeGate.ok) {
      return toolFail(name, name, modeGate.error)
    }
    if (context.runEnabledMcpIds && !context.runEnabledMcpIds.has(mcp.serverId)) {
      return toolFail(
        name,
        name,
        `MCP server "${mcp.serverId}" is not enabled for this workspace run`
      )
    }
    if (context.stepMcpToolNames && !context.stepMcpToolNames.has(name)) {
      const counts = context.mcpNotInCatalogCounts
      const failureCount = counts
        ? recordMcpNotInCatalogFailure(counts, name)
        : 1
      if (failureCount >= MCP_NOT_IN_CATALOG_FAIL_FAST_THRESHOLD) {
        return toolFail(name, name, mcpNotInCatalogFailFastMessage(name, failureCount))
      }
      return toolFail(
        name,
        name,
        mcpNotInCatalogErrorMessage(name, {
          alreadyPinned: context.runPinnedMcpToolNames?.has(name) === true
        })
      )
    }
    const policy = context.mcpToolPolicies?.get(mcp.serverId)
    if (policy && !isMcpToolPermitted(mcp.toolName, policy)) {
      return toolFail(
        name,
        name,
        `MCP tool "${mcp.toolName}" is blocked by this server's allow/deny list`
      )
    }
    const def = getMcpToolDefinition(name)
    if (!def) {
      return toolFail(name, name, `Unknown or unavailable MCP tool: ${name}`)
    }
    const checked = validateAgainstJsonSchema(
      def.parameters as Record<string, unknown> | undefined,
      parsed
    )
    if (!checked.ok) {
      logger.warn('Invalid MCP tool args', {
        scope: 'tools',
        code: 'TOOL_ARGS',
        tool: name
      })
      return toolFail(name, 'invalid args', checked.error)
    }
    const stamp = Math.max(context.currentStep ?? 1, 1)
    context.mcpLastUsedByName?.set(name, stamp)
    recordMcpFilesystemPriors(mcp.serverId, mcp.toolName, parsed, {
      runDir: context.runDir,
      skipWriteCheckpoint: context.skipWriteCheckpoint
    })
    return invokeMcpTool(
      mcp.serverId,
      mcp.toolName,
      parsed,
      signal,
      name,
      context.runEnabledMcpIds,
      workspace
    )
  }

  const validated = validateToolArgs(name, argsJson)
  if (!validated.ok) {
    logger.warn('Invalid tool args', {
      scope: 'tools',
      code: 'TOOL_ARGS',
      tool: name
    })
    return toolFail(name, 'invalid args', validated.error)
  }
  const args = validated.data
  const modeGate = assertToolAllowedInMode(agentMode, name, args, {
    autoModeSwitch: context.autoModeSwitch
  })
  if (!modeGate.ok) {
    return toolFail(name, summarizeToolArgsFromRecord(name, args), modeGate.error)
  }
  const summary = summarizeToolArgsFromRecord(name, args)
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_HANDLERS, name)) {
    return toolFail(name, name, `Unknown tool: ${name}`)
  }
  const handler = BUILTIN_HANDLERS[name as AgentToolName]

  // Remap run artifacts to the run directory (not the workspace root):
  // Plan: plan.md + contract.md; Agent: contract.md + existing plan.md.
  let effectiveWorkspace = workspace
  let effectiveArgs = args
  let effectiveContext = context

  const shouldRemapPath = (pathArg: string): boolean => {
    if (!pathArg) return false
    if (agentMode === 'plan' && isPlanArtifactPath(pathArg)) return true
    if (agentMode === 'agent' && isRunContractPath(pathArg)) return true
    if (
      agentMode === 'agent' &&
      isRunPlanPath(pathArg) &&
      context.runDir &&
      existsSync(join(context.runDir, 'plan.md'))
    ) {
      return true
    }
    return false
  }

  const remapPathArg = (pathArg: string): string => {
    const n = pathArg.replace(/\\/g, '/').replace(/^\.\//, '')
    return basename(n)
  }

  if (name === 'multi_edit' && Array.isArray(args.edits)) {
    const edits = args.edits as Array<Record<string, unknown>>
    let anyRemap = false
    const remapped = edits.map((edit) => {
      const p = typeof edit.path === 'string' ? edit.path : ''
      if (!shouldRemapPath(p)) return edit
      anyRemap = true
      return { ...edit, path: remapPathArg(p) }
    })
    if (anyRemap) {
      if (!context.runDir) {
        return toolFail(name, summary, 'Run artifacts require an active run directory')
      }
      effectiveWorkspace = context.runDir
      effectiveArgs = { ...args, edits: remapped }
      effectiveContext = { ...context, skipWriteCheckpoint: true }
    }
  } else {
    const pathArg = typeof args.path === 'string' ? args.path : ''
    const remapRunArtifact =
      (name === 'edit' || name === 'str_replace' || name === 'read') && shouldRemapPath(pathArg)
    if (remapRunArtifact) {
      if (!context.runDir) {
        return toolFail(name, summary, 'Run artifacts require an active run directory')
      }
      effectiveWorkspace = context.runDir
      effectiveArgs = { ...args, path: remapPathArg(pathArg) }
      if (name === 'edit' || name === 'str_replace') {
        effectiveContext = { ...context, skipWriteCheckpoint: true }
      }
    }
  }

  try {
    return await handler(effectiveWorkspace, effectiveArgs, signal, effectiveContext)
  } catch (err) {
    if (isAbortError(err)) {
      logger.warn('Tool aborted', { scope: 'tools', tool: name })
      throw err
    }
    const message = formatError(err)
    logToolFailure(name, err)
    return toolFail(name, summary, message, { failureLogged: true })
  }
}
