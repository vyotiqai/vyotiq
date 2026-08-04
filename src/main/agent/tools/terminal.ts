import { spawn, spawnSync } from 'child_process'
import kill from 'tree-kill'
import { assertInsideWorkspace } from '../../../shared/workspacePath'
import type { TerminalShell } from '../../../shared/ipc'
import { parseTerminalOutput } from '../../../shared/utils/terminalFormat'

/** stdout/stderr cap returned to the model (each stream). */
export const TERMINAL_MAX_OUTPUT = 64 * 1024
/** Upper bound for model-requested command timeouts (5 minutes). */
export const TERMINAL_MAX_TIMEOUT_MS = 300_000
const MAX_OUTPUT = TERMINAL_MAX_OUTPUT

/** Resolved shell used for spawn (never `auto`). */
export type ResolvedTerminalShell = 'cmd' | 'powershell' | 'bash' | 'unix'

/** Unix tools that typically fail or mislead under Windows cmd.exe. */
const UNIX_PRIMARY_ON_WINDOWS = new Set([
  'ls',
  'grep',
  'egrep',
  'fgrep',
  'head',
  'tail',
  'find',
  'cat',
  'which',
  'pwd',
  'rm',
  'cp',
  'mv',
  'chmod',
  'chown',
  'touch',
  'ln',
  'wc',
  'awk',
  'sed',
  'xargs',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'stat',
  'uname',
  'tee',
  'tr',
  'cut',
  'uniq',
  'export',
  'source',
  'bash',
  'sh',
  'zsh'
])

const UNIX_CMD_HINTS: Record<string, string> = {
  ls: 'dir',
  grep: 'findstr',
  egrep: 'findstr',
  fgrep: 'findstr',
  head: 'more (or PowerShell Get-Content -TotalCount)',
  tail: 'PowerShell Get-Content -Tail',
  find: 'dir /s /b',
  cat: 'type',
  which: 'where',
  pwd: 'echo %CD%',
  rm: 'del',
  cp: 'copy',
  mv: 'move',
  touch: 'type nul > file',
  wc: 'find /c /v ""',
  bash: 'cmd.exe builtins',
  sh: 'cmd.exe builtins',
  zsh: 'cmd.exe builtins'
}

export function commandOnPath(bin: string): boolean {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(finder, [bin], {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env
  })
  return result.status === 0 && Boolean(result.stdout?.trim())
}

function unixShellInvocation(command: string): { bin: string; args: string[] } {
  const shell = process.env.SHELL?.trim()
  if (shell) return { bin: shell, args: ['-lc', command] }
  return { bin: '/bin/sh', args: ['-c', command] }
}

function powershellInvocation(command: string): { bin: string; args: string[] } {
  const bin = commandOnPath('pwsh') ? 'pwsh' : 'powershell'
  return {
    bin,
    args: ['-NoProfile', '-NonInteractive', '-Command', command]
  }
}

function bashInvocation(command: string): { bin: string; args: string[] } {
  return { bin: 'bash', args: ['-lc', command] }
}

/**
 * Resolve settings preference to a concrete shell for this platform.
 * Exported for tests.
 */
export function resolveTerminalShell(
  preference: TerminalShell = 'auto',
  platform: NodeJS.Platform = process.platform
): ResolvedTerminalShell {
  if (preference === 'cmd') return platform === 'win32' ? 'cmd' : 'unix'
  if (preference === 'powershell') return 'powershell'
  if (preference === 'bash') return 'bash'
  // auto
  if (platform !== 'win32') return 'unix'
  if (commandOnPath('pwsh') || commandOnPath('powershell')) return 'powershell'
  return 'cmd'
}

export type TerminalSpawnSpec = {
  resolved: ResolvedTerminalShell
  bin: string
  args: string[]
}

/** Build spawn bin/args for a resolved shell. Exported for tests. */
export function terminalSpawnSpec(
  command: string,
  resolved: ResolvedTerminalShell
): TerminalSpawnSpec {
  if (resolved === 'cmd') {
    return { resolved, bin: 'cmd.exe', args: ['/c', command] }
  }
  if (resolved === 'powershell') {
    const inv = powershellInvocation(command)
    return { resolved, bin: inv.bin, args: inv.args }
  }
  if (resolved === 'bash') {
    const inv = bashInvocation(command)
    return { resolved, bin: inv.bin, args: inv.args }
  }
  const inv = unixShellInvocation(command)
  return { resolved, bin: inv.bin, args: inv.args }
}

/** First executable token of a command (cmd-safe parsing). Exported for tests. */
export function primaryCommandToken(command: string): string | null {
  let s = command.trim()
  if (!s) return null
  s = s.replace(/^(?:cmd(?:\.exe)?\s+\/c\s+)/i, '')
  const first = s.split(/\s*(?:&&|\|\||[|;&])\s*/)[0]?.trim() ?? ''
  if (!first) return null
  const m = first.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/)
  const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim()
  if (!raw) return null
  const base = raw.replace(/^.*[/\\]/, '').replace(/\.(?:exe|cmd|bat)$/i, '')
  return base.toLowerCase() || null
}

/** Last pipeline stage token (e.g. `dir | findstr x` → findstr). Exported for tests. */
export function lastPipelineCommandToken(command: string): string | null {
  const stages = command.split('|')
  const last = stages[stages.length - 1] ?? command
  return primaryCommandToken(last)
}

/**
 * On Windows cmd shell, if any pipeline stage's primary command is a common Unix builtin,
 * return a helpful failure message (no spawn). Otherwise null.
 */
export function unsupportedUnixOnWindowsMessage(command: string): string | null {
  const stages = command
    .split('|')
    .map((s) => primaryCommandToken(s.trim()))
    .filter((t): t is string => Boolean(t))
  const unixStages = stages.filter((t) => UNIX_PRIMARY_ON_WINDOWS.has(t))
  if (!unixStages.length) return null
  const token = unixStages[0]
  const equiv = UNIX_CMD_HINTS[token] ?? 'a cmd.exe-compatible command'
  const stageNote =
    unixStages.length > 1
      ? ` Also blocked in pipeline: ${unixStages.slice(1).join(', ')}.`
      : ''
  return [
    `Unsupported Unix command on Windows: "${token}".`,
    'The terminal tool is using cmd.exe (Settings → Agent → Terminal shell).',
    `Prefer cmd-safe commands (dir, findstr, where, type, echo %CD%) — e.g. use "${equiv}" instead of "${token}".${stageNote}`,
    'Switch the shell to PowerShell or bash, or use cmd-compatible commands.',
    'exit_code: 1'
  ].join('\n')
}

/** Append Windows cmd hints when a pipeline stage used a Unix-only tool. */
function appendWindowsCompatHint(
  command: string,
  content: string,
  exitCode: number | null,
  resolved: ResolvedTerminalShell
): string {
  if (resolved !== 'cmd') return content
  if (exitCode === 0 || exitCode === null) return content
  const stages = command
    .split('|')
    .map((s) => primaryCommandToken(s.trim()))
    .filter((t): t is string => Boolean(t))
  const unixStages = stages.filter((t) => UNIX_PRIMARY_ON_WINDOWS.has(t))
  if (!unixStages.length) return content
  const hints = unixStages.map((t) => {
    const equiv = UNIX_CMD_HINTS[t] ?? 'cmd.exe-compatible commands'
    return `"${t}" → try ${equiv}`
  })
  return `${content}\n\n[Windows hint] cmd.exe does not support: ${hints.join('; ')}. Use dir, findstr, where, type, or switch Terminal shell to PowerShell.`
}

/**
 * findstr exit 1 = no matches (soft success). Exit 2 = error.
 * Reject catastrophic stderr (command missing / path errors).
 */
export function isFindstrNoMatch(
  command: string,
  exitCode: number | null | undefined,
  stdout: string,
  stderr: string
): boolean {
  if (exitCode !== 1) return false
  if (lastPipelineCommandToken(command) !== 'findstr') return false
  if (/not recognized|cannot find the (?:path|file)|The system cannot find/i.test(stderr)) {
    return false
  }
  // No matches → empty/minimal stdout
  return stdout.trim().length === 0
}

/** Parse terminal tool content for findstr no-match soft success. Exported for tests. */
export function isFindstrNoMatchContent(command: string, content: string): boolean {
  const { stdout, stderr, exitCode } = parseTerminalOutput(content)
  if (exitCode == null) return false
  let cleanedStdout = stdout.replace(/^findstr: no matches\n?/m, '')
  return isFindstrNoMatch(command, exitCode, cleanedStdout, stderr)
}

/**
 * Windows `dir` exit 1 when the target path does not exist — informative, not a tool fault.
 */
export function isDirMissingPath(
  command: string,
  exitCode: number | null | undefined,
  stdout: string,
  stderr: string
): boolean {
  if (process.platform !== 'win32') return false
  if (exitCode !== 1) return false
  if (primaryCommandToken(command) !== 'dir') return false
  const combined = `${stdout}\n${stderr}`
  if (/not recognized|cannot find the (?:path|file)|The system cannot find/i.test(combined)) {
    return true
  }
  if (/File Not Found/i.test(combined)) return true
  return false
}

/** Parse terminal tool content for dir missing-path soft success. Exported for tests. */
export function isDirMissingPathContent(command: string, content: string): boolean {
  const { stdout, stderr, exitCode } = parseTerminalOutput(content)
  if (exitCode == null) return false
  const cleanedStdout = stdout.replace(/^dir: path not found\n?/m, '')
  return isDirMissingPath(command, exitCode, cleanedStdout, stderr)
}

function formatTerminalOutput(
  workspaceRoot: string,
  command: string,
  stdout: string,
  stderr: string,
  code: number | null,
  annotations: string[],
  resolved: ResolvedTerminalShell
): string {
  const cmdSoft = resolved === 'cmd'
  const dirMissing = cmdSoft && isDirMissingPath(command, code, stdout, stderr)
  let out = [
    `cwd: ${workspaceRoot}`,
    `shell: ${resolved}`,
    '',
    ...annotations,
    stdout.slice(0, MAX_OUTPUT),
    dirMissing ? 'dir: path not found' : '',
    stderr ? `stderr:\n${stderr.slice(0, MAX_OUTPUT)}` : '',
    `exit_code: ${code ?? -1}`
  ]
    .filter(Boolean)
    .join('\n')
  out = appendWindowsCompatHint(command, out, code, resolved)
  return out
}

/** Format background/poll terminal session output for the model + TerminalBody parser. */
export function formatTerminalSessionOutput(input: {
  workspaceRoot: string
  command: string
  shell: ResolvedTerminalShell
  stdout: string
  stderr: string
  exitCode: number | null
  sessionId: string
  status: string
}): string {
  const base = formatTerminalOutput(
    input.workspaceRoot,
    input.command,
    input.stdout,
    input.stderr,
    input.exitCode,
    [],
    input.shell
  )
  return [`session_id: ${input.sessionId}`, `status: ${input.status}`, `command: ${input.command}`, base].join(
    '\n'
  )
}

/**
 * Minimal env for child shells — omit parent secrets (API keys, tokens) that
 * live on process.env in the Electron main process.
 */
export function sanitizedTerminalEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const keys = [
    'PATH',
    'Path',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'USERNAME',
    'USER',
    'LOGNAME',
    'TMP',
    'TEMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'ComSpec',
    'COMSPEC',
    'SystemRoot',
    'SYSTEMROOT',
    'SystemDrive',
    'SYSTEMDRIVE',
    'windir',
    'WINDIR',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'SHELL',
    'PWD',
    'OLDPWD',
    'HOMEBREW_PREFIX',
    'HOMEBREW_CELLAR'
  ]

  const env: Record<string, string> = {}
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  // Ensure PATH exists even if the parent somehow lacks it.
  if (!env.PATH && !env.Path) {
    env.PATH = source.PATH ?? source.Path ?? ''
  }
  return env
}

export type ToolTerminalOptions = {
  timeoutMs?: number
  /** Settings preference; resolved at spawn time. */
  shell?: TerminalShell
  /** Absolute cwd already resolved inside the workspace (defaults to workspace root). */
  cwd?: string
  /** Live stdout/stderr chunks for UI streaming (capped with the buffers). */
  onOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
}

export async function toolTerminal(
  workspaceRoot: string,
  command: string,
  signal: AbortSignal,
  timeoutMsOrOpts: number | ToolTerminalOptions = 60_000
): Promise<string> {
  assertInsideWorkspace(workspaceRoot, '.')

  const opts: ToolTerminalOptions =
    typeof timeoutMsOrOpts === 'number' ? { timeoutMs: timeoutMsOrOpts } : timeoutMsOrOpts
  const timeoutMs = Math.min(opts.timeoutMs ?? 60_000, TERMINAL_MAX_TIMEOUT_MS)
  const cwd = opts.cwd ?? workspaceRoot
  const resolved = resolveTerminalShell(opts.shell ?? 'auto')
  const spec = terminalSpawnSpec(command, resolved)

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    if (resolved === 'cmd') {
      const unixHint = unsupportedUnixOnWindowsMessage(command)
      if (unixHint) {
        resolve(`cwd: ${workspaceRoot}\nshell: cmd\n\n${unixHint}`)
        return
      }
    }

    if (resolved === 'bash' && !commandOnPath('bash')) {
      resolve(
        [
          `cwd: ${workspaceRoot}`,
          'shell: bash',
          '',
          'bash was not found on PATH. Install Git Bash or set Terminal shell to auto/PowerShell/cmd.',
          'exit_code: 1'
        ].join('\n')
      )
      return
    }

    if (resolved === 'powershell' && !commandOnPath('pwsh') && !commandOnPath('powershell')) {
      resolve(
        [
          `cwd: ${workspaceRoot}`,
          'shell: powershell',
          '',
          'PowerShell was not found on PATH. Set Terminal shell to cmd or install PowerShell.',
          'exit_code: 1'
        ].join('\n')
      )
      return
    }

    const child = spawn(spec.bin, spec.args, {
      cwd,
      env: sanitizedTerminalEnv(),
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    const onAbort = (): void => {
      if (child.pid) kill(child.pid)
      finish(() => reject(new DOMException('Aborted', 'AbortError')))
    }

    const timer = setTimeout(() => {
      if (child.pid) kill(child.pid)
      finish(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }

    signal.addEventListener('abort', onAbort)

    child.stdout.on('data', (buf: Buffer) => {
      if (stdout.length >= MAX_OUTPUT) return
      const text = buf.toString('utf8')
      const room = MAX_OUTPUT - stdout.length
      const clipped = text.length > room ? text.slice(0, room) : text
      stdout += clipped
      if (clipped) opts.onOutput?.({ text: clipped, stream: 'stdout' })
    })
    child.stderr.on('data', (buf: Buffer) => {
      if (stderr.length >= MAX_OUTPUT) return
      const text = buf.toString('utf8')
      const room = MAX_OUTPUT - stderr.length
      const clipped = text.length > room ? text.slice(0, room) : text
      stderr += clipped
      if (clipped) opts.onOutput?.({ text: clipped, stream: 'stderr' })
    })

    child.on('error', (err) => {
      finish(() => reject(err))
    })

    child.on('close', (code) => {
      const findstrNoMatch =
        resolved === 'cmd' && isFindstrNoMatch(command, code, stdout, stderr)
      const out = formatTerminalOutput(
        workspaceRoot,
        command,
        stdout,
        stderr,
        code,
        [findstrNoMatch ? 'findstr: no matches' : ''],
        resolved
      )
      finish(() => resolve(out))
    })
  })
}

/** Exported for unit tests. */
export { unixShellInvocation }
