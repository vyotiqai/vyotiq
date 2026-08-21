import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import {
  commandOnPath,
  formatTerminalSessionOutput,
  killProcessTree,
  killProcessTreeAndWait,
  resolveTerminalShell,
  sanitizedTerminalEnv,
  stripPowerShellPatternNoise,
  terminalSpawnSpec,
  type ResolvedTerminalShell
} from './terminal'
import { compileUserRegex } from './safeUserRegex'
import { workspacePathIsInside, workspacePathsEqual } from '../../../shared/workspacePath'
import type { TerminalShell } from '../../../shared/ipc'
import { lowerProcessPriority } from '../processPriority'

export type TerminalSessionStatus = 'running' | 'done' | 'timeout' | 'pattern_matched' | 'aborted'

/** Resource-safety limit: max concurrent background terminal sessions per run invoke. */
export const MAX_BACKGROUND_TERMINALS_PER_INVOKE = 8

type TerminalSession = {
  id: string
  runId: string
  invokeId: number
  workspaceRoot: string
  /** Directory the child actually spawned in — reported to the model as `cwd:`. */
  cwd: string
  command: string
  shell: ResolvedTerminalShell
  child: ChildProcess
  stdout: string
  stderr: string
  exitCode: number | null
  running: boolean
  status: TerminalSessionStatus
  pattern?: RegExp
  patternMatched?: boolean
  createdAt: number
  onOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
  /** Resolvers waiting for close / pattern / status change (event-driven poll). */
  waiters: Set<() => void>
}

const sessions = new Map<string, TerminalSession>()

function notifySessionWaiters(session: TerminalSession): void {
  if (session.waiters.size === 0) return
  const waiters = [...session.waiters]
  session.waiters.clear()
  for (const wake of waiters) wake()
}

function patternHaystack(session: TerminalSession): string {
  const hay = `${session.stdout}\n${session.stderr}`
  return session.shell === 'powershell' ? stripPowerShellPatternNoise(hay) : hay
}

function matchesPattern(session: TerminalSession): boolean {
  if (!session.pattern) return false
  if (session.patternMatched) return true
  if (!session.running && session.status !== 'running') return false
  const matched = session.pattern.test(patternHaystack(session))
  if (matched) session.patternMatched = true
  return matched
}

function assertSessionOwnership(
  session: TerminalSession | undefined,
  sessionId: string,
  runId: string,
  invokeId: number
): asserts session is TerminalSession {
  if (!session) {
    throw new Error(
      `Unknown terminal session_id: ${sessionId}. Background shells do not survive app restart — start a new command.`
    )
  }
  if (session.runId !== runId || session.invokeId !== invokeId) {
    throw new Error(`Terminal session does not belong to run: ${sessionId}`)
  }
}

export function getTerminalSession(
  id: string,
  runId: string,
  invokeId: number
): TerminalSession | undefined {
  const session = sessions.get(id)
  try {
    assertSessionOwnership(session, id, runId, invokeId)
  } catch {
    return undefined
  }
  return session
}

export function disposeTerminalSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  if (session.running && session.child.pid) {
    killProcessTree(session.child.pid, 'dispose')
  }
  session.running = false
  if (session.status === 'running') session.status = 'aborted'
  notifySessionWaiters(session)
  sessions.delete(id)
}

export function resetTerminalSessionsForTests(): void {
  for (const id of [...sessions.keys()]) disposeTerminalSession(id)
}

/** @internal Test helper — count sessions owned by a run invoke. */
export function countTerminalSessionsForInvoke(runId: string, invokeId: number): number {
  let count = 0
  for (const session of sessions.values()) {
    if (session.runId === runId && session.invokeId === invokeId) count++
  }
  return count
}

/** @internal Test helper — total live background sessions. */
export function countTerminalSessionsGlobalForTests(): number {
  return sessions.size
}

export function disposeTerminalSessionsForInvoke(runId: string, invokeId: number): number {
  let disposed = 0
  for (const session of [...sessions.values()]) {
    if (session.runId !== runId || session.invokeId !== invokeId) continue
    disposeTerminalSession(session.id)
    disposed++
  }
  return disposed
}

export function disposeTerminalSessionsForWorkspace(workspacePath: string): number {
  let disposed = 0
  for (const session of [...sessions.values()]) {
    if (!workspacePathsEqual(session.workspaceRoot, workspacePath)) continue
    disposeTerminalSession(session.id)
    disposed++
  }
  return disposed
}

/** Kill sessions whose cwd or workspace root sits under `root` (instance worktree teardown). */
export async function disposeTerminalSessionsUnderPath(root: string): Promise<number> {
  const trimmed = root.trim()
  if (!trimmed) return 0
  const pids: number[] = []
  let disposed = 0
  for (const session of [...sessions.values()]) {
    if (
      !workspacePathIsInside(trimmed, session.cwd) &&
      !workspacePathIsInside(trimmed, session.workspaceRoot)
    ) {
      continue
    }
    if (session.running && session.child.pid) pids.push(session.child.pid)
    disposeTerminalSession(session.id)
    disposed++
  }
  await Promise.all(pids.map((pid) => killProcessTreeAndWait(pid, 'worktree-teardown')))
  return disposed
}

export function disposeAllTerminalSessions(): void {
  for (const id of [...sessions.keys()]) disposeTerminalSession(id)
}

function formatSession(session: TerminalSession): string {
  return formatTerminalSessionOutput({
    cwd: session.cwd,
    command: session.command,
    shell: session.shell,
    stdout: session.stdout,
    stderr: session.stderr,
    exitCode: session.exitCode,
    sessionId: session.id,
    status: session.status
  })
}

/**
 * Wait until the session stops running, matches pattern, aborts, or deadline.
 * Wakes immediately on close/pattern via session waiters (no 100ms busy-poll).
 */
function waitForSessionEvent(
  session: TerminalSession,
  signal: AbortSignal,
  deadline: number
): Promise<void> {
  if (!session.running || session.status !== 'running' || signal.aborted) {
    return Promise.resolve()
  }
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      session.waiters.delete(finish)
      signal.removeEventListener('abort', finish)
      clearTimeout(timer)
      resolve()
    }
    session.waiters.add(finish)
    signal.addEventListener('abort', finish, { once: true })
    const timer = setTimeout(finish, remaining)
  })
}

export type StartBackgroundTerminalOpts = {
  runId: string
  invokeId: number
  workspaceRoot: string
  /** Absolute cwd inside workspace; defaults to workspaceRoot. */
  cwd?: string
  command: string
  signal: AbortSignal
  shell?: TerminalShell
  pattern?: string
  /** Wait this long before returning (0 = immediate). */
  blockUntilMs: number
  onOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
}

export async function startBackgroundTerminal(
  opts: StartBackgroundTerminalOpts
): Promise<string> {
  const command = opts.command.trim()
  if (!command) throw new Error('command is required to start a terminal session')

  const cwd = opts.cwd ?? opts.workspaceRoot
  const resolved = resolveTerminalShell(opts.shell ?? 'auto')
  if (resolved === 'bash' && !commandOnPath('bash')) {
    return [
      `cwd: ${cwd}`,
      'shell: bash',
      '',
      'bash was not found on PATH.',
      'exit_code: 1'
    ].join('\n')
  }
  if (resolved === 'powershell' && !commandOnPath('pwsh') && !commandOnPath('powershell')) {
    return [
      `cwd: ${cwd}`,
      'shell: powershell',
      '',
      'PowerShell was not found on PATH.',
      'exit_code: 1'
    ].join('\n')
  }

  let invokeCount = 0
  for (const s of sessions.values()) {
    if (s.runId === opts.runId && s.invokeId === opts.invokeId) invokeCount++
  }
  if (invokeCount >= MAX_BACKGROUND_TERMINALS_PER_INVOKE) {
    return [
      `cwd: ${cwd}`,
      `shell: ${resolved}`,
      '',
      `Too many concurrent background terminal sessions for this invoke (limit ${MAX_BACKGROUND_TERMINALS_PER_INVOKE}). Wait for existing sessions to finish or dispose them.`,
      'exit_code: 1'
    ].join('\n')
  }

  const spec = terminalSpawnSpec(command, resolved)
  const id = randomUUID()
  let pattern: RegExp | undefined
  if (opts.pattern?.trim()) {
    try {
      pattern = compileUserRegex(opts.pattern)
    } catch (err) {
      throw new Error(
        err instanceof Error ? `Invalid terminal pattern regex: ${err.message}` : `Invalid terminal pattern regex: ${opts.pattern}`
      )
    }
  }

  const child = spawn(spec.bin, spec.args, {
    cwd,
    env: sanitizedTerminalEnv(),
    windowsHide: true
  })
  if (child.pid) lowerProcessPriority(child.pid)

  const session: TerminalSession = {
    id,
    runId: opts.runId,
    invokeId: opts.invokeId,
    workspaceRoot: opts.workspaceRoot,
    cwd,
    command,
    shell: resolved,
    child,
    stdout: '',
    stderr: '',
    exitCode: null,
    running: true,
    status: 'running',
    pattern,
    patternMatched: false,
    createdAt: Date.now(),
    onOutput: opts.onOutput,
    waiters: new Set()
  }
  sessions.set(id, session)

  const onAbort = (): void => {
    if (session.running && child.pid) killProcessTree(child.pid, 'session-abort')
    session.running = false
    session.status = 'aborted'
    notifySessionWaiters(session)
  }
  if (opts.signal.aborted) onAbort()
  else opts.signal.addEventListener('abort', onAbort, { once: true })

  child.stdout?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8')
    session.stdout += text
    if (text) session.onOutput?.({ text, stream: 'stdout' })
    if (session.pattern && !session.patternMatched && matchesPattern(session) && session.running) {
      session.status = 'pattern_matched'
      notifySessionWaiters(session)
    }
  })
  child.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8')
    session.stderr += text
    if (text) session.onOutput?.({ text, stream: 'stderr' })
    if (session.pattern && !session.patternMatched && matchesPattern(session) && session.running) {
      session.status = 'pattern_matched'
      notifySessionWaiters(session)
    }
  })
  child.on('error', () => {
    session.running = false
    session.status = 'done'
    session.exitCode = 1
    notifySessionWaiters(session)
  })
  child.on('close', (code) => {
    session.running = false
    session.exitCode = code
    if (session.status === 'running' || session.status === 'pattern_matched') {
      session.status = matchesPattern(session) ? 'pattern_matched' : 'done'
    }
    opts.signal.removeEventListener('abort', onAbort)
    notifySessionWaiters(session)
  })

  return await pollTerminalSession({
    runId: opts.runId,
    invokeId: opts.invokeId,
    sessionId: id,
    blockUntilMs: opts.blockUntilMs,
    pattern: opts.pattern,
    signal: opts.signal
  })
}

export type PollTerminalSessionOpts = {
  runId: string
  invokeId: number
  sessionId: string
  blockUntilMs: number
  pattern?: string
  signal: AbortSignal
  /** Hard run-cancel signal — distinguishes Cancelled (kill) from Interrupted (keep running). */
  runSignal?: AbortSignal
  onOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
}

export async function pollTerminalSession(opts: PollTerminalSessionOpts): Promise<string> {
  const session = sessions.get(opts.sessionId)
  assertSessionOwnership(session, opts.sessionId, opts.runId, opts.invokeId)
  if (opts.onOutput) session.onOutput = opts.onOutput
  if (opts.pattern?.trim()) {
    try {
      session.pattern = compileUserRegex(opts.pattern)
    } catch (err) {
      throw new Error(
        err instanceof Error
          ? `Invalid terminal pattern regex: ${err.message}`
          : `Invalid terminal pattern regex: ${opts.pattern}`
      )
    }
  }

  const deadline = Date.now() + Math.max(0, opts.blockUntilMs)
  while (Date.now() < deadline) {
    if (opts.signal.aborted) {
      // Hard cancel kills the child so it cannot leak past the run; a soft
      // steer (follow-up) only ends this poll — the session stays alive and
      // un-poisoned so later polls keep working.
      const hardCancel = !opts.runSignal || opts.runSignal.aborted
      if (hardCancel) {
        if (session.running && session.child.pid) {
          killProcessTree(session.child.pid, 'poll-hard-cancel')
        }
        session.running = false
        session.status = 'aborted'
        notifySessionWaiters(session)
      }
      break
    }
    if (!session.running) break
    if (matchesPattern(session)) {
      session.status = 'pattern_matched'
      notifySessionWaiters(session)
      break
    }
    await waitForSessionEvent(session, opts.signal, deadline)
  }

  if (session.running && opts.blockUntilMs > 0 && session.status === 'running') {
    // Timed out waiting; leave process running for further polls.
    return formatSession({ ...session, status: 'timeout' })
  }
  return formatSession(session)
}
