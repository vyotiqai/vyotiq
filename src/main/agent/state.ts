import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync, openSync, readSync, closeSync, fstatSync } from 'fs'
import { readFile, readdir, open } from 'fs/promises'
import { join, basename } from 'path'
import { atomicWriteFile, atomicWriteFileAsync, atomicWriteJson } from '../storage/atomicWrite'
import { enqueueEventAppend, flushEventAppends } from './eventAppendQueue'
import {
  enqueueMessageAppend,
  enqueueMessageRewrite,
  flushMessageAppends,
  takeMessageAppendFailureNotice
} from './messageAppendQueue'
import { enqueueStatusPatch, flushStatusWrites, writeStatusImmediate } from './statusWriteQueue'
import { getCachedListRuns, invalidateListRunsCache } from './runListCache'
import {
  ChatMessageSchema,
  PersistedEventSchema,
  RunStatusSchema,
  contentToText,
  runDoneDedupeKey,
  runErrorDedupeKey,
  type AgentInteractionMode,
  type ChatMessage,
  type ListRunsResult,
  type MessageContent,
  type PersistedEvent,
  type RunStatus,
  type RunSummary
} from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { RUN_INTERRUPTED_ERROR } from '../../shared/runInterrupt'
import { workspaceIdFromPath } from '../../shared/utils/workspaceId'
import { toolResultEventForPersistence } from '../../shared/utils/toolResultIpc'
import { finalizeInterruptedTodos } from './tools/todo'
import { finalizeTodoContentOnRunEnd, type TodoFinalizeOutcome } from '../../shared/utils/todoContent'
import { DEFAULT_PLAN_STUB, stripPlanStubChrome } from '../../shared/planStub'
import { ensureWorkspaceStorage, resolveRunDir, workspaceSessionsRoot } from '../storage/paths'
import { isActive } from './runRegistry'
import { dismissLifecycleNotification } from '../notifications/bus'
import {
  finalizeInstanceWorktree,
  isSafeInstanceWorktreePath
} from '../git/instanceWorktree'
import { CompactionRecordSchema, type CompactionRecord } from './context/types'
import {
  applyFoldedMessagesWatermark,
  stripLeadingOrphanToolMessages
} from './context/foldWatermark'
import { writeRunReceiptBestEffort } from './runReceipt'
import { RUN_LIST_CAP } from '@shared/domain/runs'

export { flushEventAppends, takeEventAppendFailureNotice } from './eventAppendQueue'
export { flushMessageAppends, takeMessageAppendFailureNotice } from './messageAppendQueue'
export { flushStatusWrites } from './statusWriteQueue'

const CONTRACT_CAP = 4000

export function readContract(runDir: string): string {
  const p = join(runDir, 'contract.md')
  if (!existsSync(p)) return ''
  try {
    const text = readFileSync(p, 'utf8').trim()
    if (!text) return ''
    if (text.length <= CONTRACT_CAP) return text
    return text.slice(0, CONTRACT_CAP) + '\n…'
  } catch {
    return ''
  }
}

export async function readContractAsync(runDir: string): Promise<string> {
  const p = join(runDir, 'contract.md')
  if (!existsSync(p)) return ''
  try {
    const text = (await readFile(p, 'utf8')).trim()
    if (!text) return ''
    if (text.length <= CONTRACT_CAP) return text
    return text.slice(0, CONTRACT_CAP) + '\n…'
  } catch {
    return ''
  }
}

export { DEFAULT_PLAN_STUB }

/** Approved/draft plan artifact; empty when missing or still the Plan-mode stub. */
export async function readPlanAsync(runDir: string): Promise<string> {
  const text = await readPlanRawAsync(runDir)
  if (!text) return ''
  const withoutStub = stripPlanStubChrome(text)
  if (withoutStub.replace(/[_*.\s]/g, '').length < 20) return ''
  return text
}

/**
 * Full plan.md contents, stub included and never truncated — the Plan-mode
 * prompt mirrors this verbatim so the model edits against the real file.
 */
export async function readPlanRawAsync(runDir: string): Promise<string> {
  const p = join(runDir, 'plan.md')
  if (!existsSync(p)) return ''
  try {
    return (await readFile(p, 'utf8')).trim()
  } catch {
    return ''
  }
}

export function saveCompaction(runDir: string, record: CompactionRecord): boolean {
  const parsed = CompactionRecordSchema.safeParse(record)
  if (!parsed.success) {
    logger.warn('Invalid compaction record; not saved', {
      scope: 'state',
      correlationId: basename(runDir),
      err: parsed.error
    })
    return false
  }
  try {
    atomicWriteJson(join(runDir, 'compaction.json'), parsed.data)
    return true
  } catch (err) {
    logger.warn('Failed to write compaction.json', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return false
  }
}

export function loadCompaction(runDir: string): CompactionRecord | null {
  const p = join(runDir, 'compaction.json')
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    const parsed = CompactionRecordSchema.safeParse(raw)
    if (!parsed.success) {
      logger.warn('Invalid compaction.json', {
        scope: 'state',
        correlationId: basename(runDir)
      })
      return null
    }
    return parsed.data
  } catch (err) {
    logger.warn('Failed to read compaction.json', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return null
  }
}

/** Persisted sticky tool catalog for prompt-cache continuity across resume. */
export type ToolCatalogStickyRecord = {
  version: 1
  keptNames: string[]
  fingerprint: string
  updatedAt: string
  /**
   * MCP tool name → last agent step pinned or invoked.
   * Optional for older toolCatalog.json files; when absent, resume seeds pins to the current step.
   */
  mcpLastUsedByName?: Record<string, number>
}

function normalizeMcpLastUsedByName(
  raw: unknown
): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [name, step] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name !== 'string' || !name.startsWith('mcp__')) continue
    if (typeof step !== 'number' || !Number.isFinite(step) || step < 1) continue
    out[name] = Math.floor(step)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function saveToolCatalogSticky(
  runDir: string,
  keptNames: readonly string[],
  fingerprint: string,
  mcpLastUsedByName?: ReadonlyMap<string, number> | Record<string, number>
): boolean {
  const lastUsedRaw =
    mcpLastUsedByName instanceof Map
      ? Object.fromEntries(mcpLastUsedByName.entries())
      : mcpLastUsedByName
  const mcpLastUsed = normalizeMcpLastUsedByName(lastUsedRaw)
  const record: ToolCatalogStickyRecord = {
    version: 1,
    keptNames: [...keptNames],
    fingerprint,
    updatedAt: new Date().toISOString(),
    ...(mcpLastUsed ? { mcpLastUsedByName: mcpLastUsed } : {})
  }
  try {
    atomicWriteJson(join(runDir, 'toolCatalog.json'), record)
    return true
  } catch (err) {
    logger.warn('Failed to write toolCatalog.json', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return false
  }
}

export function loadToolCatalogSticky(runDir: string): ToolCatalogStickyRecord | null {
  const p = join(runDir, 'toolCatalog.json')
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<ToolCatalogStickyRecord>
    if (raw?.version !== 1 || !Array.isArray(raw.keptNames) || raw.keptNames.length === 0) {
      return null
    }
    const keptNames = raw.keptNames.filter((n): n is string => typeof n === 'string' && n.length > 0)
    if (keptNames.length === 0) return null
    const mcpLastUsedByName = normalizeMcpLastUsedByName(raw.mcpLastUsedByName)
    return {
      version: 1,
      keptNames,
      fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : keptNames.join('|'),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      ...(mcpLastUsedByName ? { mcpLastUsedByName } : {})
    }
  } catch (err) {
    logger.warn('Failed to read toolCatalog.json', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return null
  }
}

export function runExists(workspacePath: string, runId: string): boolean {
  const dir = resolveRunDir(workspacePath, runId)
  return existsSync(dir) && existsSync(join(dir, 'status.json'))
}

export async function resumeRun(workspacePath: string, runId: string): Promise<string> {
  const dir = resolveRunDir(workspacePath, runId)
  if (!existsSync(dir)) {
    throw new Error('Run not found')
  }
  // chatStart may already have queued the follow-up user turn.
  await flushMessageAppends(dir)
  // Close any unfinished tool pairing from a previous crash before continuing.
  appendOrphanToolStubs(dir, runId)
  const prior = loadStatus(dir)
  await updateStatus(
    dir,
    {
      status: 'running',
      // Keep prior step count across invokes (do not reset progress metadata).
      step: prior?.step ?? 0,
      error: undefined,
      resumable: undefined,
      interruptedAt: undefined
    },
    { sync: true }
  )
  return dir
}

export function loadStatus(dir: string): RunStatus | null {
  const p = join(dir, 'status.json')
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    const parsed = RunStatusSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Stamp `at` on user messages that were persisted without a send time. */
export function ensureUserMessageAt(
  message: ChatMessage,
  at = new Date().toISOString()
): ChatMessage {
  if (message.role !== 'user' || message.at) return message
  return { ...message, at }
}

export function syncMessages(dir: string, messages: ChatMessage[]): void {
  const body = messages.map((m) => JSON.stringify(m)).join('\n')
  atomicWriteFile(join(dir, 'messages.jsonl'), body ? `${body}\n` : '')
}

/** Await pending async appends, then rewrite messages.jsonl (authoritative).
 * Uses the async atomic writer so long-transcript rewrites never block the
 * main-thread event loop mid-run. */
export async function syncMessagesAsync(dir: string, messages: ChatMessage[]): Promise<void> {
  await flushMessageAppends(dir)
  const body = messages.map((m) => JSON.stringify(m)).join('\n')
  await atomicWriteFileAsync(join(dir, 'messages.jsonl'), body ? `${body}\n` : '')
}

export function appendMessage(dir: string, message: ChatMessage): Promise<void> {
  const line = `${JSON.stringify(ensureUserMessageAt(message))}\n`
  return enqueueMessageAppend(dir, line)
}

export type CreateRunOptions = {
  mode?: AgentInteractionMode
  parentRunId?: string
  inlineInstance?: true
  pathScope?: string[]
  worktreePath?: string
  worktreeBranch?: string
}

export function createRun(
  workspacePath: string,
  runId: string,
  goal: string,
  modeOrOptions: AgentInteractionMode | CreateRunOptions = 'agent'
): string {
  const options: CreateRunOptions =
    typeof modeOrOptions === 'string' ? { mode: modeOrOptions } : modeOrOptions
  const mode = options.mode ?? 'agent'
  const dir = resolveRunDir(workspacePath, runId)
  ensureWorkspaceStorage(workspacePath)
  mkdirSync(dir, { recursive: true })
  const goalText = goal.trim() || 'chat'
  atomicWriteFile(
    join(dir, 'contract.md'),
    [
      '## Goal',
      '',
      goalText,
      '',
      '## Done when',
      '',
      '- The goal above is satisfied (check outcomes: read results, command output, or user-visible success).',
      '- Or blockers are explained clearly and no further narrow retry will help.',
      '- Update this file if scope or done-when changes.',
      ''
    ].join('\n')
  )
  const status: RunStatus = {
    status: 'running',
    step: 0,
    updatedAt: new Date().toISOString(),
    goal: goalText.slice(0, 200),
    workspacePath,
    mode,
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(options.inlineInstance ? { inlineInstance: true as const } : {}),
    ...(options.pathScope?.length ? { pathScope: options.pathScope } : {}),
    ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
    ...(options.worktreeBranch ? { worktreeBranch: options.worktreeBranch } : {})
  }
  atomicWriteJson(join(dir, 'status.json'), status)
  atomicWriteFile(join(dir, 'messages.jsonl'), '')
  atomicWriteFile(join(dir, 'events.jsonl'), '')
  invalidateListRunsCache(workspacePath)
  return dir
}

/** Persist trimmed agent events to events.jsonl (full tool output stays in messages.jsonl). */
export function appendEvent(dir: string, event: unknown): void {
  enqueueEventAppend(dir, event)
}

/** Await pending event appends, then rewrite events.jsonl (authoritative). */
export async function syncEventsAsync(dir: string, events: unknown[]): Promise<void> {
  await flushEventAppends(dir)
  const body = events
    .map((event) =>
      JSON.stringify({
        at: new Date().toISOString(),
        event
      })
    )
    .join('\n')
  atomicWriteFile(join(dir, 'events.jsonl'), body ? `${body}\n` : '')
}

export async function updateStatus(
  dir: string,
  patch: Partial<RunStatus>,
  options?: { sync?: boolean }
): Promise<void> {
  if (options?.sync) {
    await writeStatusImmediate(
      dir,
      patch,
      (path, next) => atomicWriteJson(path, next),
      (path) => {
        let current: RunStatus = {
          status: 'running',
          step: 0,
          updatedAt: new Date().toISOString()
        }
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
          const parsed = RunStatusSchema.safeParse(raw)
          if (parsed.success) current = parsed.data
        } catch {
          // keep default
        }
        return current
      }
    )
    return
  }
  enqueueStatusPatch(dir, patch)
}

function parseMessagesJsonl(content: string): ChatMessage[] {
  return parseMessagesJsonlSkipping(content, 0)
}

/**
 * Parse messages.jsonl but skip the first `skipCount` successfully-parsed
 * messages (fold watermark). Avoids retaining folded tool bodies as ChatMessage
 * objects — the dominant heap cost of a full reload after compaction.
 */
function parseMessagesJsonlSkipping(content: string, skipCount: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  let skipped = 0
  let lineNo = 0
  for (const line of content.split('\n')) {
    if (!line) continue
    lineNo++
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      logger.warn('Skipping invalid messages.jsonl line (JSON)', {
        scope: 'state',
        line: lineNo
      })
      continue
    }
    const parsed = ChatMessageSchema.safeParse(json)
    if (!parsed.success) {
      logger.warn('Skipping invalid messages.jsonl line (schema)', {
        scope: 'state',
        line: lineNo
      })
      continue
    }
    if (skipped < skipCount) {
      skipped++
      continue
    }
    messages.push(parsed.data)
  }
  return messages
}

export function loadMessages(workspacePath: string, runId: string): ChatMessage[] {
  const dir = resolveRunDir(workspacePath, runId)
  const p = join(dir, 'messages.jsonl')
  if (!existsSync(p)) return []
  return parseMessagesJsonl(readFileSync(p, 'utf8'))
}

/**
 * Load only the post-fold working set from disk (skip parsing folded prefix).
 * Equivalent to `applyFoldedMessagesWatermark(loadMessages(...), fold)` without
 * materializing the folded ChatMessage objects.
 */
export function loadMessagesAfterFold(
  workspacePath: string,
  runId: string,
  foldedMessages: number
): ChatMessage[] {
  const dir = resolveRunDir(workspacePath, runId)
  const p = join(dir, 'messages.jsonl')
  if (!existsSync(p)) return []
  const skip = Math.max(0, Math.floor(foldedMessages))
  return parseMessagesJsonlSkipping(readFileSync(p, 'utf8'), skip)
}

export async function loadMessagesAsync(
  workspacePath: string,
  runId: string
): Promise<ChatMessage[]> {
  const dir = resolveRunDir(workspacePath, runId)
  await flushMessageAppends(dir)
  const p = join(dir, 'messages.jsonl')
  if (!existsSync(p)) return []
  try {
    return parseMessagesJsonl(await readFile(p, 'utf8'))
  } catch (err) {
    logger.warn('Failed to read messages.jsonl', { scope: 'state', runId, err })
    return []
  }
}

export async function loadMessagesAfterFoldAsync(
  workspacePath: string,
  runId: string,
  foldedMessages: number
): Promise<ChatMessage[]> {
  const dir = resolveRunDir(workspacePath, runId)
  await flushMessageAppends(dir)
  const p = join(dir, 'messages.jsonl')
  if (!existsSync(p)) return []
  try {
    const skip = Math.max(0, Math.floor(foldedMessages))
    return parseMessagesJsonlSkipping(await readFile(p, 'utf8'), skip)
  } catch (err) {
    logger.warn('Failed to read messages.jsonl', { scope: 'state', runId, err })
    return []
  }
}

/**
 * Post-fold working set without materializing folded ChatMessage bodies.
 * Falls back to a full parse only when the post-fold window is entirely orphan tools
 * (matches `applyFoldedMessagesWatermark` rewind semantics).
 */
export function loadWorkingMessagesForFold(
  workspacePath: string,
  runId: string,
  foldedMessages: number
): { messages: ChatMessage[]; foldedMessages: number } {
  const fold = Math.max(0, Math.floor(foldedMessages))
  if (fold <= 0) {
    return { messages: loadMessages(workspacePath, runId), foldedMessages: 0 }
  }
  const after = loadMessagesAfterFold(workspacePath, runId, fold)
  const kept = stripLeadingOrphanToolMessages(after)
  if (kept.length > 0) {
    return {
      messages: kept,
      foldedMessages: fold + (after.length - kept.length)
    }
  }
  return applyFoldedMessagesWatermark(loadMessages(workspacePath, runId), fold)
}

function toolMessageText(content: MessageContent): string {
  return typeof content === 'string' ? content : contentToText(content)
}

/** Backward-scan window for tool-result lookup — recent output usually lives here. */
const TOOL_RESULT_TAIL_WINDOW_BYTES = 256 * 1024

function parseToolLine(line: string, toolCallId: string): string | null {
  if (!line) return null
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const row = json as { role?: unknown; toolCallId?: unknown }
  if (row.role !== 'tool' || row.toolCallId !== toolCallId) return null
  const parsed = ChatMessageSchema.safeParse(json)
  if (!parsed.success || parsed.data.role !== 'tool') return null
  return toolMessageText(parsed.data.content)
}

/**
 * Read full persisted tool output for lazy UI expansion (IPC ships a preview only).
 * Scans newest-first through growing byte-tail windows so typical expansions read
 * ~256 KB instead of re-loading the entire multi-MB transcript.
 */
export async function loadToolResultContent(
  workspacePath: string,
  runId: string,
  toolCallId: string
): Promise<string | null> {
  const dir = resolveRunDir(workspacePath, runId)
  await flushMessageAppends(dir)
  const p = join(dir, 'messages.jsonl')
  if (!existsSync(p)) return null
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(p, 'r')
  } catch {
    logger.warn('Failed to open messages.jsonl for tool result', {
      scope: 'state',
      runId,
      toolCallId
    })
    return null
  }
  try {
    const { size } = await fh.stat()
    // Bytes not yet known to end at a line boundary (partial oldest line).
    let pending: Buffer = Buffer.alloc(0)
    let end = size
    while (end > 0) {
      const start = Math.max(0, end - TOOL_RESULT_TAIL_WINDOW_BYTES)
      const buf = Buffer.alloc(end - start)
      await fh.read(buf, 0, buf.length, start)
      pending = Buffer.concat([buf, pending])
      end = start

      // Only consume up to the last complete newline unless we reached file head.
      let usable = pending.length
      if (end > 0) {
        const lastNl = pending.lastIndexOf(0x0a)
        if (lastNl === -1) continue
        usable = lastNl
      }
      const segment = pending.subarray(0, usable).toString('utf8')
      pending = end > 0 ? pending.subarray(usable + 1) : Buffer.alloc(0)

      const lines = segment.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const hit = parseToolLine(lines[i], toolCallId)
        if (hit !== null) return hit
      }
    }
    if (pending.length > 0) {
      const hit = parseToolLine(pending.toString('utf8'), toolCallId)
      if (hit !== null) return hit
    }
    return null
  } catch (err) {
    logger.warn('Failed to read messages.jsonl for tool result', {
      scope: 'state',
      runId,
      toolCallId,
      err
    })
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}

function normalizePersistedEvent(
  row: PersistedEvent,
  runId: string
): PersistedEvent {
  const event = row.event
  if (!event || typeof event !== 'object') return row
  const ev = event as Record<string, unknown>
  if (typeof ev.runId === 'string' && ev.runId.length > 0) return row
  return {
    ...row,
    event: { ...ev, runId }
  }
}

function parseEventsFromText(
  text: string,
  inferredRunId: string,
  options?: { limit?: number }
): PersistedEvent[] {
  const events: PersistedEvent[] = []
  const lines = text.split('\n')
  const limit = options?.limit
  const start =
    limit != null && limit > 0 && lines.length > limit ? Math.max(0, lines.length - limit) : 0
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]
    if (!line) continue
    try {
      const json: unknown = JSON.parse(line)
      const parsed = PersistedEventSchema.safeParse(json)
      if (!parsed.success) {
        logger.warn('Skipping invalid events.jsonl line (schema)', {
          scope: 'state',
          line: index + 1
        })
        continue
      }
      events.push(normalizePersistedEvent(parsed.data, inferredRunId))
    } catch {
      logger.warn('Skipping invalid events.jsonl line (json)', {
        scope: 'state',
        line: index + 1
      })
    }
  }
  return events
}

/**
 * Read approximately the last `byteBudget` bytes of a file so callers can parse
 * a trailing window of JSONL without loading multi-MB histories.
 */
function readFileTailSync(path: string, byteBudget: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size <= 0) return ''
    const start = Math.max(0, size - byteBudget)
    const length = size - start
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const firstNl = text.indexOf('\n')
      text = firstNl >= 0 ? text.slice(firstNl + 1) : text
    }
    return text
  } finally {
    closeSync(fd)
  }
}

/** Heuristic: ~2KB average event line × limit, with a floor for short files. */
function eventsTailByteBudget(limit: number): number {
  return Math.max(64 * 1024, limit * 2048)
}

/** Sync read — does not block on pending appends. Prefer {@link loadEventsAsync} on hot paths. */
export function loadEvents(
  dir: string,
  runId?: string,
  options?: { limit?: number }
): PersistedEvent[] {
  const p = join(dir, 'events.jsonl')
  if (!existsSync(p)) return []
  const inferredRunId = runId ?? basename(dir)
  const limit = options?.limit
  const text =
    limit != null && limit > 0
      ? readFileTailSync(p, eventsTailByteBudget(limit))
      : readFileSync(p, 'utf8')
  return parseEventsFromText(text, inferredRunId, options)
}

export async function loadEventsAsync(
  dir: string,
  runId?: string,
  options?: { limit?: number }
): Promise<PersistedEvent[]> {
  await flushEventAppends(dir)
  const p = join(dir, 'events.jsonl')
  if (!existsSync(p)) return []
  const inferredRunId = runId ?? basename(dir)
  const limit = options?.limit
  const text =
    limit != null && limit > 0
      ? readFileTailSync(p, eventsTailByteBudget(limit))
      : await readFile(p, 'utf8')
  return parseEventsFromText(text, inferredRunId, options)
}

/** Default UI restore bound — full history stays on disk. */
export const LOAD_EVENTS_UI_LIMIT = 500

const CRITICAL_HYDRATION_TYPES = new Set([
  'writes_checkpoint',
  'incomplete',
  'error',
  'status',
  'mode_changed',
  'compaction_verify_failed'
])

/**
 * Walk events.jsonl from the end and keep the latest row of each hydration-critical
 * type. Avoids losing writes_checkpoint / terminal status / mode when the UI tail
 * cap drops older lines.
 */
function collectLatestCriticalEvents(text: string, inferredRunId: string): PersistedEvent[] {
  const found = new Map<string, PersistedEvent>()
  const writeCheckpoints: PersistedEvent[] = []
  const seenCheckpointIds = new Set<string>()
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line) continue
    try {
      const json: unknown = JSON.parse(line)
      const parsed = PersistedEventSchema.safeParse(json)
      if (!parsed.success) continue
      const row = normalizePersistedEvent(parsed.data, inferredRunId)
      const event = row.event
      if (!event || typeof event !== 'object') continue
      const type = (event as { type?: unknown }).type
      if (typeof type !== 'string' || !CRITICAL_HYDRATION_TYPES.has(type)) continue
      if (type === 'status') {
        const status = (event as { status?: unknown }).status
        if (status !== 'done' && status !== 'cancelled' && status !== 'error') continue
      }
      if (type === 'writes_checkpoint') {
        const checkpointId = (event as { checkpointId?: unknown }).checkpointId
        if (typeof checkpointId !== 'string' || seenCheckpointIds.has(checkpointId)) continue
        seenCheckpointIds.add(checkpointId)
        writeCheckpoints.push(row)
        continue
      }
      if (!found.has(type)) found.set(type, row)
    } catch {
      // skip bad line
    }
  }
  return [...found.values(), ...writeCheckpoints]
}

function mergeCriticalHydrationEvents(
  uiEvents: PersistedEvent[],
  critical: PersistedEvent[]
): PersistedEvent[] {
  if (critical.length === 0) return uiEvents
  const out = [...uiEvents]
  for (const crit of critical) {
    const event = crit.event
    if (!event || typeof event !== 'object') continue
    const type = (event as { type?: unknown }).type
    if (typeof type !== 'string') continue
    const already = out.some((row) => {
      const ev = row.event
      if (!ev || typeof ev !== 'object') return false
      if ((ev as { type?: unknown }).type !== type) return false
      if (type === 'writes_checkpoint') {
        return (
          (ev as { checkpointId?: unknown }).checkpointId ===
          (event as { checkpointId?: unknown }).checkpointId
        )
      }
      return true
    })
    if (!already) out.push(crit)
  }
  return out
}

/**
 * UI restore: last N events plus hydration-critical rows from a wider trailing
 * window so writes_checkpoint / mode_changed / terminal status survive long runs.
 */
export async function loadEventsForHydrationAsync(
  dir: string,
  runId?: string,
  options?: { limit?: number }
): Promise<PersistedEvent[]> {
  await flushEventAppends(dir)
  const p = join(dir, 'events.jsonl')
  if (!existsSync(p)) return []
  const inferredRunId = runId ?? basename(dir)
  const limit = options?.limit ?? LOAD_EVENTS_UI_LIMIT
  const uiEvents = await loadEventsAsync(dir, inferredRunId, { limit })
  // Wider than the UI line cap so a checkpoint just outside the 500-event window
  // still hydrates Keep/Discard without loading the entire history.
  const criticalText = readFileTailSync(p, eventsTailByteBudget(Math.max(limit * 10, 2000)))
  const critical = collectLatestCriticalEvents(criticalText, inferredRunId)
  return mergeCriticalHydrationEvents(uiEvents, critical)
}

export function loadEventsForRun(
  workspacePath: string,
  runId: string,
  options?: { limit?: number }
): PersistedEvent[] {
  const dir = resolveRunDir(workspacePath, runId)
  if (!existsSync(join(dir, 'events.jsonl'))) return []
  return loadEvents(dir, runId, options)
}

export async function loadEventsForRunAsync(
  workspacePath: string,
  runId: string,
  options?: { limit?: number }
): Promise<PersistedEvent[]> {
  const dir = resolveRunDir(workspacePath, runId)
  if (!existsSync(join(dir, 'events.jsonl'))) return []
  return loadEventsForHydrationAsync(dir, runId, options)
}


async function collectRunsFromRoot(root: string): Promise<{
  parents: RunSummary[]
  instances: RunSummary[]
}> {
  const parents: RunSummary[] = []
  const instances: RunSummary[] = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { parents, instances }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    try {
      const statusPath = join(dir, 'status.json')
      const raw = JSON.parse(await readFile(statusPath, 'utf8')) as unknown
      const parsed = RunStatusSchema.safeParse(raw)
      if (!parsed.success) {
        logger.warn('Skipping run with invalid status.json', {
          scope: 'state',
          runId: entry.name
        })
        continue
      }
      const status = parsed.data
      const summary: RunSummary = {
        runId: entry.name,
        status: status.status,
        updatedAt: status.updatedAt,
        goal: status.goal,
        ...(status.resumable ? { resumable: true as const } : {}),
        ...(status.error ? { error: status.error } : {}),
        ...(status.parentRunId ? { parentRunId: status.parentRunId } : {}),
        ...(status.inlineInstance ? { inlineInstance: true as const } : {}),
        ...(status.pathScope?.length ? { pathScope: status.pathScope } : {}),
        ...(status.worktreePath ? { worktreePath: status.worktreePath } : {}),
        ...(status.worktreeBranch ? { worktreeBranch: status.worktreeBranch } : {})
      }
      if (status.inlineInstance && status.parentRunId) {
        instances.push(summary)
      } else if (!status.inlineInstance) {
        parents.push(summary)
      }
    } catch (err) {
      logger.warn('Run listing skipped entry', {
        scope: 'runs',
        runDir: entry.name,
        err
      })
    }
  }
  return { parents, instances }
}

export async function listRuns(workspacePath: string): Promise<ListRunsResult> {
  return getCachedListRuns(workspacePath, async () => {
    // Reconcile only on cache miss/TTL expiry — avoids disk walk every sidebar poll.
    await reconcileStaleRuns(workspacePath)
    const { parents, instances } = await collectRunsFromRoot(
      workspaceSessionsRoot(workspacePath)
    )
    const sortedParents = parents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const parentIds = new Set(sortedParents.slice(0, RUN_LIST_CAP).map((r) => r.runId))
    const instanceRuns = instances
      .filter((r) => r.parentRunId != null && parentIds.has(r.parentRunId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return {
      runs: sortedParents.slice(0, RUN_LIST_CAP),
      instanceRuns,
      capped: sortedParents.length > RUN_LIST_CAP
    }
  })
}

/** Persist failure stubs for tool calls that never received a result before interrupt. */
function appendOrphanToolStubs(dir: string, runId: string): void {
  const messagesPath = join(dir, 'messages.jsonl')
  if (!existsSync(messagesPath)) return
  const messages = parseMessagesJsonl(readFileSync(messagesPath, 'utf8'))
  const completedIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) completedIds.add(message.toolCallId)
  }
  const stub = 'Cancelled'
  const repaired: ChatMessage[] = []
  let changed = false
  for (const message of messages) {
    repaired.push(message)
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue
    for (const call of message.toolCalls) {
      if (completedIds.has(call.id)) continue
      completedIds.add(call.id)
      changed = true
      repaired.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: stub,
        ok: false
      })
      appendEvent(
        dir,
        toolResultEventForPersistence({
          type: 'tool_result',
          runId,
          toolCallId: call.id,
          name: call.name,
          summary: 'cancelled',
          ok: false,
          content: stub
        })
      )
    }
  }
  if (changed) syncMessages(dir, repaired)
}

/**
 * Demote in-progress markers on every todo_write tool message after run-end.
 * Keeps historical checklist snapshots; only clears spinners (`[~]`).
 */
export async function patchLatestTodoWriteMessage(
  dir: string,
  outcomeOrContent: TodoFinalizeOutcome | string
): Promise<void> {
  // Queued behind pending appends: the terminal error paths flush a partial
  // assistant message without awaiting, and an unserialized rewrite would drop it.
  await enqueueMessageRewrite(dir, () => {
    const messagesPath = join(dir, 'messages.jsonl')
    if (!existsSync(messagesPath)) return
    const messages = parseMessagesJsonl(readFileSync(messagesPath, 'utf8'))
    let changed = false
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (message?.role !== 'tool' || message.toolName !== 'todo_write') continue
      const current = toolMessageText(message.content)
      const next =
        outcomeOrContent === 'done' ||
        outcomeOrContent === 'error' ||
        outcomeOrContent === 'cancelled'
          ? finalizeTodoContentOnRunEnd(current, outcomeOrContent)
          : outcomeOrContent
      if (next === current) continue
      messages[index] = { ...message, content: next }
      changed = true
    }
    if (changed) syncMessages(dir, messages)
  })
}

/**
 * Mark runs left as `running` after a crash/restart as cancelled.
 * Scans workspace run directories under each provided path.
 * When `maxAgeMs` is 0 (default), every disk-`running` non-active run is cancelled immediately.
 */
export async function interruptOrphanRuns(
  workspacePaths: string[],
  maxAgeMs = 0
): Promise<number> {
  let count = 0
  for (const workspacePath of workspacePaths) {
    const runs = workspaceSessionsRoot(workspacePath)
    if (!existsSync(runs)) continue
    let workspaceCount = 0
    for (const name of readdirSync(runs)) {
      const dir = join(runs, name)
      try {
        if (!statSync(dir).isDirectory()) continue
        const statusPath = join(dir, 'status.json')
        if (!existsSync(statusPath)) continue
        const raw = JSON.parse(readFileSync(statusPath, 'utf8')) as unknown
        const parsed = RunStatusSchema.safeParse(raw)
        if (!parsed.success) continue
        if (parsed.data.status !== 'running') continue
        // Skip runs still live in memory (re-adding an open workspace must not
        // treat an in-flight agent as a crash orphan).
        if (isActive(name)) continue
        if (!isRunStaleByAge(parsed.data.updatedAt, maxAgeMs)) continue
        await interruptRunningRunOnDisk(workspacePath, name, dir, parsed.data)
        workspaceCount += 1
      } catch (err) {
        logger.warn('Orphan interrupt skipped entry', {
          scope: 'runs',
          runId: name,
          err
        })
      }
    }
    if (workspaceCount > 0) invalidateListRunsCache(workspacePath)
    count += workspaceCount
  }
  return count
}

const DEFAULT_STALE_RUN_AGE_MS = 120_000

function isRunStaleByAge(updatedAt: string, maxAgeMs: number): boolean {
  if (maxAgeMs <= 0) return true
  const ts = Date.parse(updatedAt)
  if (!Number.isFinite(ts)) return true
  return Date.now() - ts >= maxAgeMs
}

async function finalizeInlineInstanceWorktreeBestEffort(
  workspacePath: string,
  status: RunStatus,
  opts?: { keepBranch?: boolean }
): Promise<void> {
  if (!status.inlineInstance || !status.worktreePath) return
  if (!isSafeInstanceWorktreePath(workspacePath, status.worktreePath)) {
    logger.warn('orphan interrupt skipped unsafe instance worktree path', {
      scope: 'runs',
      worktreePath: status.worktreePath
    })
    return
  }
  try {
    await finalizeInstanceWorktree(workspacePath, status.worktreePath, {
      keepBranch: opts?.keepBranch ?? status.status === 'done',
      branch: status.worktreeBranch
    })
  } catch (err) {
    logger.warn('orphan interrupt worktree finalize failed', {
      scope: 'runs',
      worktreePath: status.worktreePath,
      err
    })
  }
}

async function interruptRunningRunOnDisk(
  workspacePath: string,
  runId: string,
  dir: string,
  status: RunStatus
): Promise<void> {
  appendOrphanToolStubs(dir, runId)
  finalizeInterruptedTodos(dir)
  await patchLatestTodoWriteMessage(dir, 'cancelled')
  await finalizeInlineInstanceWorktreeBestEffort(workspacePath, status, { keepBranch: false })
  await updateStatus(
    dir,
    {
      status: 'cancelled',
      error: RUN_INTERRUPTED_ERROR,
      resumable: true,
      interruptedAt: new Date().toISOString(),
      step: status.step,
      ...(status.invokeId != null ? { invokeId: status.invokeId } : {})
    },
    { sync: true }
  )
  appendEvent(dir, {
    type: 'status',
    status: 'cancelled',
    runId,
    ...(status.invokeId != null ? { invokeId: status.invokeId } : {})
  })
  await flushEventAppends(dir)
  await flushStatusWrites(dir)
  const events = await loadEventsAsync(dir, runId)
  writeRunReceiptBestEffort({
    runDir: dir,
    runId,
    loadStatus,
    loadMessages: () => loadMessages(workspacePath, runId),
    loadEvents: () => events,
    readContract
  })
}

/** Reconcile disk-`running` runs older than `maxAgeMs` when listing or loading sessions. */
export async function reconcileStaleRuns(
  workspacePath: string,
  maxAgeMs = DEFAULT_STALE_RUN_AGE_MS
): Promise<number> {
  let count = 0
  const runs = workspaceSessionsRoot(workspacePath)
  let entries
  try {
    entries = await readdir(runs, { withFileTypes: true })
  } catch (err) {
    logger.warn('Run reconcile skipped workspace sessions root', {
      scope: 'runs',
      workspacePath,
      err
    })
    return 0
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(runs, entry.name)
    try {
      const statusPath = join(dir, 'status.json')
      const raw = JSON.parse(await readFile(statusPath, 'utf8')) as unknown
      const parsed = RunStatusSchema.safeParse(raw)
      if (!parsed.success) {
        logger.warn('Run reconcile skipped invalid status.json', {
          scope: 'runs',
          runId: entry.name
        })
        continue
      }
      if (parsed.data.status !== 'running') continue
      if (isActive(entry.name)) continue
      if (!isRunStaleByAge(parsed.data.updatedAt, maxAgeMs)) continue
      await interruptRunningRunOnDisk(workspacePath, entry.name, dir, parsed.data)
      count += 1
    } catch (err) {
      logger.warn('Run reconcile skipped entry', {
        scope: 'runs',
        runId: entry.name,
        err
      })
    }
  }
  // Called from listRuns cache miss only — caller writes fresh cache after.
  return count
}

function dismissRunLifecycleInbox(runId: string): void {
  const id = runId.trim()
  if (!id) return
  dismissLifecycleNotification(runDoneDedupeKey(id))
  dismissLifecycleNotification(runErrorDedupeKey(id))
}

export async function deleteRun(
  workspacePath: string,
  runId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isActive(runId)) {
    return { ok: false, error: 'Cancel run first' }
  }
  const dir = resolveRunDir(workspacePath, runId)
  if (!existsSync(dir)) {
    return { ok: false, error: 'Run not found' }
  }
  const status = loadStatus(dir)

  if (!status?.inlineInstance) {
    const { instances } = await collectRunsFromRoot(workspaceSessionsRoot(workspacePath))
    const children = instances.filter((r) => r.parentRunId === runId)
    if (children.some((c) => isActive(c.runId))) {
      return { ok: false, error: 'Cancel instance runs first' }
    }
    for (const child of children) {
      const childDir = resolveRunDir(workspacePath, child.runId)
      const childStatus = loadStatus(childDir)
      if (childStatus) {
        await finalizeInlineInstanceWorktreeBestEffort(workspacePath, childStatus, {
          keepBranch: false
        })
      }
      if (existsSync(childDir)) {
        rmSync(childDir, { recursive: true, force: true })
      }
      dismissRunLifecycleInbox(child.runId)
    }
  }

  if (status?.inlineInstance && status.worktreePath) {
    await finalizeInlineInstanceWorktreeBestEffort(workspacePath, status)
  }
  rmSync(dir, { recursive: true, force: true })
  dismissRunLifecycleInbox(runId)
  invalidateListRunsCache(workspacePath)
  logger.info('Deleted run', {
    scope: 'agent',
    runId,
    workspaceId: workspaceIdFromPath(workspacePath),
    channel: 'runs:delete'
  })
  return { ok: true }
}

const GOAL_SECTION_RE = /(## Goal\s*\n)([\s\S]*?)(\n## )/

export function renameRun(workspacePath: string, runId: string, goal: string): RunSummary {
  if (isActive(runId)) {
    throw new Error('Cancel run first')
  }
  const dir = resolveRunDir(workspacePath, runId)
  if (!existsSync(dir)) {
    throw new Error('Run not found')
  }
  const goalText = goal.trim().slice(0, 200)
  const statusPath = join(dir, 'status.json')
  const raw = JSON.parse(readFileSync(statusPath, 'utf8')) as unknown
  const parsed = RunStatusSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error('Invalid run status')
  }
  const next: RunStatus = {
    ...parsed.data,
    goal: goalText,
    updatedAt: new Date().toISOString()
  }
  const contractPath = join(dir, 'contract.md')
  if (existsSync(contractPath)) {
    const contract = readFileSync(contractPath, 'utf8')
    const updated = GOAL_SECTION_RE.test(contract)
      ? contract.replace(GOAL_SECTION_RE, `$1${goalText}$3`)
      : contract
    atomicWriteFile(contractPath, updated)
  }
  atomicWriteJson(statusPath, next)
  invalidateListRunsCache(workspacePath)

  return {
    runId,
    status: next.status,
    updatedAt: next.updatedAt,
    goal: goalText
  }
}
