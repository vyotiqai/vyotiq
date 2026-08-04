import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import kill from 'tree-kill'
import {
  commandOnPath,
  formatTerminalSessionOutput,
  resolveTerminalShell,
  sanitizedTerminalEnv,
  terminalSpawnSpec,
  unsupportedUnixOnWindowsMessage,
  type ResolvedTerminalShell,
  TERMINAL_MAX_OUTPUT
} from './terminal'
import { compileUserRegex } from './safeUserRegex'
import { workspacePathsEqual } from '../../../shared/workspacePath'
import type { TerminalShell } from '../../../shared/ipc'

export type TerminalSessionStatus = 'running' | 'done' | 'timeout' | 'pattern_matched' | 'aborted'

type TerminalSession = {
  id: string
  runId: string
  invokeId: number
  workspaceRoot: string
  command: string
  shell: ResolvedTerminalShell
  child: ChildProcess
  stdout: string
  stderr: string
  exitCode: number | null
  running: boolean
  status: TerminalSessionStatus
  pattern?: RegExp
  createdAt: number
  onOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
}

const sessions = new Map<string, TerminalSession>()
const MAX_OUTPUT = TERMINAL_MAX_OUTPUT

function appendCapped(
  prev: string,
  chunk: string
): { next: string; emitted: string } {
  if (prev.length >= MAX_OUTPUT) return { next: prev, emitted: '' }
  const room = MAX_OUTPUT - prev.length
  const emitted = chunk.length > room ? chunk.slice(0, room) : chunk
  return { next: prev + emitted, emitted }
}

function matchesPattern(session: TerminalSession): boolean {
  if (!session.pattern) return false
  const hay = `${session.stdout}\n${session.stderr}`
  return session.pattern.test(hay)
}

function assertSessionOwnership(
  session: TerminalSession | undefined,
  sessionId: string,
  runId: string,
  invokeId: number
): asserts session is TerminalSession {
  if (!session) {
    throw new Error(`Unknown terminal session_id: ${sessionId}`)
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
    try {
      kill(session.child.pid)
    } catch {
      // ignore
    }
  }
  sessions.delete(id)
}

export function resetTerminalSessionsForTests(): void {
  for (const id of [...sessions.keys()]) disposeTerminalSession(id)
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

export function disposeAllTerminalSessions(): void {
  for (const id of [...sessions.keys()]) disposeTerminalSession(id)
}

function formatSession(session: TerminalSession): string {
  return formatTerminalSessionOutput({
    workspaceRoot: session.workspaceRoot,
    command: session.command,
    shell: session.shell,
    stdout: session.stdout,
    stderr: session.stderr,
    exitCode: session.exitCode,
    sessionId: session.id,
    status: session.status
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

  const resolved = resolveTerminalShell(opts.shell ?? 'auto')
  if (resolved === 'cmd') {
    const unixHint = unsupportedUnixOnWindowsMessage(command)
    if (unixHint) {
      return `cwd: ${opts.workspaceRoot}\nshell: cmd\n\n${unixHint}`
    }
  }
  if (resolved === 'bash' && !commandOnPath('bash')) {
    return [
      `cwd: ${opts.workspaceRoot}`,
      'shell: bash',
      '',
      'bash was not found on PATH.',
      'exit_code: 1'
    ].join('\n')
  }
  if (resolved === 'powershell' && !commandOnPath('pwsh') && !commandOnPath('powershell')) {
    return [
      `cwd: ${opts.workspaceRoot}`,
      'shell: powershell',
      '',
      'PowerShell was not found on PATH.',
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

  const cwd = opts.cwd ?? opts.workspaceRoot
  const child = spawn(spec.bin, spec.args, {
    cwd,
    env: sanitizedTerminalEnv(),
    windowsHide: true
  })

  const session: TerminalSession = {
    id,
    runId: opts.runId,
    invokeId: opts.invokeId,
    workspaceRoot: opts.workspaceRoot,
    command,
    shell: resolved,
    child,
    stdout: '',
    stderr: '',
    exitCode: null,
    running: true,
    status: 'running',
    pattern,
    createdAt: Date.now(),
    onOutput: opts.onOutput
  }
  sessions.set(id, session)

  const onAbort = (): void => {
    if (session.running && child.pid) kill(child.pid)
    session.running = false
    session.status = 'aborted'
  }
  if (opts.signal.aborted) onAbort()
  else opts.signal.addEventListener('abort', onAbort, { once: true })

  child.stdout?.on('data', (buf: Buffer) => {
    const { next, emitted } = appendCapped(session.stdout, buf.toString('utf8'))
    session.stdout = next
    if (emitted) session.onOutput?.({ text: emitted, stream: 'stdout' })
    if (matchesPattern(session) && session.running) {
      session.status = 'pattern_matched'
    }
  })
  child.stderr?.on('data', (buf: Buffer) => {
    const { next, emitted } = appendCapped(session.stderr, buf.toString('utf8'))
    session.stderr = next
    if (emitted) session.onOutput?.({ text: emitted, stream: 'stderr' })
    if (matchesPattern(session) && session.running) {
      session.status = 'pattern_matched'
    }
  })
  child.on('error', () => {
    session.running = false
    session.status = 'done'
    session.exitCode = 1
  })
  child.on('close', (code) => {
    session.running = false
    session.exitCode = code
    if (session.status === 'running' || session.status === 'pattern_matched') {
      session.status = matchesPattern(session) ? 'pattern_matched' : 'done'
    }
    opts.signal.removeEventListener('abort', onAbort)
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
          try {
            kill(session.child.pid)
          } catch {
            // ignore — process may already be gone
          }
        }
        session.running = false
        session.status = 'aborted'
      }
      break
    }
    if (!session.running) break
    if (matchesPattern(session)) {
      session.status = 'pattern_matched'
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  if (session.running && opts.blockUntilMs > 0 && session.status === 'running') {
    // Timed out waiting; leave process running for further polls.
    return formatSession({ ...session, status: 'timeout' })
  }
  return formatSession(session)
}
