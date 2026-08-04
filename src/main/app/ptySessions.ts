import { randomUUID } from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc/channels'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { getSettings } from '../settings/settings'
import { resolveTerminalShell, sanitizedTerminalEnv } from '../agent/tools/terminal'
import type { PtySessionInfo } from '../../shared/ipc'
import { getMainWindow } from './window'

type SessionBackend =
  | { kind: 'pty'; pty: any }
  | { kind: 'pipe'; child: ChildProcessWithoutNullStreams }

type PtyHandle = {
  id: string
  title: string
  cwd: string
  workspacePath: string
  running: boolean
  backend: SessionBackend
  /** Ring buffer for macOS window recreate / late subscriber recovery. */
  scrollback: string
}

const sessions = new Map<string, PtyHandle>()
const PTY_SCROLLBACK_MAX = 200_000

function appendScrollback(handle: PtyHandle, data: string): void {
  handle.scrollback += data
  if (handle.scrollback.length > PTY_SCROLLBACK_MAX) {
    handle.scrollback = handle.scrollback.slice(-PTY_SCROLLBACK_MAX)
  }
}

function shellTitle(): string {
  const resolved = resolveTerminalShell(getSettings().terminalShell ?? 'auto')
  if (resolved === 'powershell') return 'powershell'
  if (resolved === 'cmd') return 'cmd'
  return 'bash'
}

function shellBinAndArgs(): { file: string; args: string[] } {
  const preference = getSettings().terminalShell ?? 'auto'
  const resolved = resolveTerminalShell(preference)
  if (resolved === 'powershell') {
    const pwsh = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    return { file: pwsh, args: ['-NoLogo'] }
  }
  if (resolved === 'cmd') {
    return { file: 'cmd.exe', args: [] }
  }
  if (resolved === 'bash') {
    return { file: 'bash', args: ['-l'] }
  }
  const shell = process.env.SHELL || '/bin/bash'
  return { file: shell, args: ['-l'] }
}

function tryLoadPty(): typeof import('node-pty') | null {
  try {
    return require('node-pty') as typeof import('node-pty')
  } catch {
    return null
  }
}

export function listPtySessions(
  workspacePath?: string,
  sessionFilter?: (sessionWorkspace: string) => boolean
): PtySessionInfo[] {
  let entries = [...sessions.values()]
  if (workspacePath) {
    entries = entries.filter((s) => workspacePathsEqual(s.workspacePath, workspacePath))
  }
  if (sessionFilter) {
    entries = entries.filter((s) => sessionFilter(s.workspacePath))
  }
  return entries.map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    running: s.running,
    backend: s.backend.kind
  }))
}

export function createPtySession(opts: {
  cwd: string
  cols?: number
  rows?: number
  sendTo: BrowserWindow
}): PtySessionInfo {
  const id = randomUUID()
  const title = shellTitle()
  const { file, args } = shellBinAndArgs()
  const nodePty = tryLoadPty()
  // Placeholder until backend is ready so early data is retained for recreate replay.
  const handle: PtyHandle = {
    id,
    title,
    cwd: opts.cwd,
    workspacePath: opts.cwd,
    running: true,
    backend: { kind: 'pipe', child: null as unknown as ChildProcessWithoutNullStreams },
    scrollback: ''
  }
  sessions.set(id, handle)

  const send = (channel: string, payload: unknown): void => {
    if (
      channel === IPC.ptyData &&
      payload &&
      typeof payload === 'object' &&
      'data' in payload &&
      typeof (payload as { data: unknown }).data === 'string'
    ) {
      appendScrollback(handle, (payload as { data: string }).data)
    }
    const current = getMainWindow()
    const target =
      current && !current.isDestroyed()
        ? current
        : !opts.sendTo.isDestroyed()
          ? opts.sendTo
          : null
    if (!target || target.webContents.isDestroyed()) return
    target.webContents.send(channel, payload)
  }

  let backend: SessionBackend | null = null
  let usedPipeFallback = false

  if (nodePty) {
    try {
      const pty = nodePty.spawn(file, args, {
        name: 'xterm-color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd: opts.cwd,
        env: sanitizedTerminalEnv()
      })
      backend = { kind: 'pty', pty }
      pty.onData((data: string) => {
        send(IPC.ptyData, { id, data })
      })
      pty.onExit(({ exitCode }: { exitCode: number }) => {
        handle.running = false
        send(IPC.ptyExit, { id, exitCode })
      })
    } catch {
      backend = null
      usedPipeFallback = true
    }
  } else {
    usedPipeFallback = true
  }

  if (!backend) {
    // Fallback when native node-pty cannot load or spawn (missing rebuild / Spectre libs).
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: sanitizedTerminalEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    backend = { kind: 'pipe', child }
    const push = (buf: Buffer): void => {
      send(IPC.ptyData, { id, data: buf.toString('utf8') })
    }
    let terminalSent = false
    const finish = (exitCode: number | null): void => {
      if (terminalSent) return
      terminalSent = true
      handle.running = false
      send(IPC.ptyExit, { id, exitCode })
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', (err) => {
      push(Buffer.from(`[vyotiq] Failed to start shell: ${err.message}\r\n`, 'utf8'))
      finish(1)
    })
    child.on('exit', (code) => {
      finish(typeof code === 'number' ? code : null)
    })
    if (usedPipeFallback) {
      send(IPC.ptyData, {
        id,
        data: `[vyotiq] Interactive PTY unavailable (node-pty not built). Using pipe shell fallback.\r\n`
      })
    }
  }

  handle.backend = backend
  return { id, title, cwd: opts.cwd, running: true, backend: backend.kind }
}

/** Rebind PTY output to a freshly created main window (macOS activate recreate). */
export function replayPtySessionsToWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  for (const s of sessions.values()) {
    if (!s.scrollback) continue
    win.webContents.send(IPC.ptyData, { id: s.id, data: s.scrollback })
  }
}

/** Test helper: seed scrollback without depending on shell echo. */
export function seedPtyScrollbackForTests(id: string, data: string): void {
  const handle = sessions.get(id)
  if (handle) appendScrollback(handle, data)
}

export function ptySessionMatchesWorkspace(id: string, workspacePath: string): boolean {
  const s = sessions.get(id)
  return s != null && workspacePathsEqual(s.workspacePath, workspacePath)
}

export function writePty(id: string, data: string, workspacePath?: string): boolean {
  const s = sessions.get(id)
  if (!s?.running) return false
  if (workspacePath && !workspacePathsEqual(s.workspacePath, workspacePath)) return false
  if (s.backend.kind === 'pty') {
    s.backend.pty.write(data)
    return true
  }
  try {
    s.backend.child.stdin.write(data)
    return true
  } catch {
    return false
  }
}

export function resizePty(id: string, cols: number, rows: number, workspacePath?: string): boolean {
  const s = sessions.get(id)
  if (!s || s.backend.kind !== 'pty') return false
  if (workspacePath && !workspacePathsEqual(s.workspacePath, workspacePath)) return false
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return false
  try {
    s.backend.pty.resize(cols, rows)
    return true
  } catch {
    return false
  }
}

export function killPty(id: string, workspacePath?: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  if (workspacePath && !workspacePathsEqual(s.workspacePath, workspacePath)) return false
  try {
    if (s.backend.kind === 'pty') s.backend.pty.kill()
    else s.backend.child.kill()
  } catch {
    /* ignore */
  }
  sessions.delete(id)
  return true
}

export function disposePtySessionsForWorkspace(workspacePath: string): number {
  let n = 0
  for (const s of [...sessions.values()]) {
    if (!workspacePathsEqual(s.workspacePath, workspacePath)) continue
    if (killPty(s.id)) n += 1
  }
  return n
}

export function disposeAllPtySessions(): void {
  for (const id of [...sessions.keys()]) {
    killPty(id)
  }
}
