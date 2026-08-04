import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isFindstrNoMatch,
  isFindstrNoMatchContent,
  isDirMissingPath,
  isDirMissingPathContent,
  lastPipelineCommandToken,
  primaryCommandToken,
  resolveTerminalShell,
  sanitizedTerminalEnv,
  terminalSpawnSpec,
  unixShellInvocation,
  unsupportedUnixOnWindowsMessage
} from '@main/agent/tools/terminal'
import { executeTool } from '@main/agent/tools'
import { toolTerminal } from '@main/agent/tools/terminal'
import { getLoggerBackend, setLoggerBackend } from '@shared/logger'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('unixShellInvocation', () => {
  const prev = process.env.SHELL

  afterEach(() => {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
  })

  it('prefers $SHELL with -lc', () => {
    process.env.SHELL = '/usr/bin/zsh'
    expect(unixShellInvocation('echo hi')).toEqual({
      bin: '/usr/bin/zsh',
      args: ['-lc', 'echo hi']
    })
  })

  it('falls back to /bin/sh -c when SHELL is unset', () => {
    delete process.env.SHELL
    expect(unixShellInvocation('ls')).toEqual({
      bin: '/bin/sh',
      args: ['-c', 'ls']
    })
  })
})

describe('sanitizedTerminalEnv', () => {
  it('keeps PATH and drops planted secrets', () => {
    const env = sanitizedTerminalEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      OPENAI_API_KEY: 'sk-secret',
      ANTHROPIC_API_KEY: 'sk-ant',
      VYOTIQ_SECRET: 'nope'
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/dev')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.VYOTIQ_SECRET).toBeUndefined()
  })
})

describe('primaryCommandToken / lastPipelineCommandToken', () => {
  it('extracts the first argv token', () => {
    expect(primaryCommandToken('ls -la')).toBe('ls')
    expect(primaryCommandToken('  grep -r foo .')).toBe('grep')
    expect(primaryCommandToken('dir /s /b *.kt')).toBe('dir')
    expect(primaryCommandToken('findstr /i pattern')).toBe('findstr')
  })

  it('strips cmd /c prefix and path/extension', () => {
    expect(primaryCommandToken('cmd /c ls')).toBe('ls')
    expect(primaryCommandToken('C:\\Windows\\System32\\findstr.exe /i x')).toBe('findstr')
  })

  it('uses the first stage before && / |', () => {
    expect(primaryCommandToken('ls | findstr x')).toBe('ls')
    expect(primaryCommandToken('dir /s /b && echo done')).toBe('dir')
  })

  it('lastPipelineCommandToken reads the final pipe stage', () => {
    expect(lastPipelineCommandToken('dir /s /b | findstr /i foo')).toBe('findstr')
    expect(lastPipelineCommandToken('findstr /i foo')).toBe('findstr')
    expect(lastPipelineCommandToken('dir /s /b')).toBe('dir')
  })
})

describe('unsupportedUnixOnWindowsMessage', () => {
  it('hints for common Unix primaries', () => {
    for (const cmd of ['ls', 'grep foo', 'head -n 5 a.txt', 'find . -name x', 'cat a.txt', 'which node']) {
      const msg = unsupportedUnixOnWindowsMessage(cmd)
      expect(msg).toBeTruthy()
      expect(msg).toMatch(/cmd\.exe/)
      expect(msg).toMatch(/exit_code: 1/)
    }
  })

  it('does not flag cmd-safe commands', () => {
    expect(unsupportedUnixOnWindowsMessage('dir /s /b')).toBeNull()
    expect(unsupportedUnixOnWindowsMessage('findstr /i foo')).toBeNull()
    expect(unsupportedUnixOnWindowsMessage('where node')).toBeNull()
    expect(unsupportedUnixOnWindowsMessage('type readme.md')).toBeNull()
    expect(unsupportedUnixOnWindowsMessage('echo hi')).toBeNull()
  })

  it('blocks Unix tools in later pipeline stages before spawn', () => {
    const msg = unsupportedUnixOnWindowsMessage('dir /s /b | grep foo')
    expect(msg).toBeTruthy()
    expect(msg).toMatch(/grep/)
    expect(msg).toMatch(/cmd\.exe/)
  })
})

describe('isFindstrNoMatch', () => {
  it('treats exit 1 + empty stdout as no-match soft success', () => {
    expect(isFindstrNoMatch('findstr /i missing', 1, '', '')).toBe(true)
    expect(isFindstrNoMatch('dir /s /b | findstr /i missing', 1, '  \n', '')).toBe(true)
  })

  it('does not soft-succeed on exit 0, exit 2, or non-findstr', () => {
    expect(isFindstrNoMatch('findstr /i x', 0, 'hit\n', '')).toBe(false)
    expect(isFindstrNoMatch('findstr /i x', 2, '', 'error')).toBe(false)
    expect(isFindstrNoMatch('dir /s /b', 1, '', '')).toBe(false)
  })

  it('rejects catastrophic stderr', () => {
    expect(
      isFindstrNoMatch('findstr /i x', 1, '', `'findstr' is not recognized as an internal or external command`)
    ).toBe(false)
    expect(isFindstrNoMatch('findstr /i x', 1, '', 'The system cannot find the path specified.')).toBe(
      false
    )
  })

  it('rejects non-empty stdout with exit 1', () => {
    expect(isFindstrNoMatch('findstr /i x', 1, 'unexpected\n', '')).toBe(false)
  })

  it('parses tool content via isFindstrNoMatchContent', () => {
    expect(
      isFindstrNoMatchContent(
        'dir /s /b | findstr /i zzznomatch',
        'findstr: no matches\nexit_code: 1'
      )
    ).toBe(true)
    expect(
      isFindstrNoMatchContent('findstr /i x', 'stderr:\n\'findstr\' is not recognized\nexit_code: 1')
    ).toBe(false)
    expect(isFindstrNoMatchContent('dir', 'exit_code: 1')).toBe(false)
  })
})

describe('isDirMissingPath', () => {
  it('treats dir missing target as soft success on win32', () => {
    if (process.platform !== 'win32') return
    expect(
      isDirMissingPath(
        'dir /b "missing-folder"',
        1,
        '',
        'The system cannot find the file specified.'
      )
    ).toBe(true)
    expect(isDirMissingPath('dir /b', 1, '', '')).toBe(false)
  })

  it('parses tool content via isDirMissingPathContent', () => {
    if (process.platform !== 'win32') return
    expect(
      isDirMissingPathContent(
        'dir /b "nope"',
        'cwd: C:\\ws\n\ndir: path not found\nstderr:\nFile Not Found\nexit_code: 1'
      )
    ).toBe(true)
  })
})

describe('resolveTerminalShell / terminalSpawnSpec', () => {
  it('maps preferences to resolved shells', () => {
    expect(resolveTerminalShell('cmd', 'win32')).toBe('cmd')
    expect(resolveTerminalShell('cmd', 'linux')).toBe('unix')
    expect(resolveTerminalShell('powershell', 'win32')).toBe('powershell')
    expect(resolveTerminalShell('bash', 'darwin')).toBe('bash')
    expect(resolveTerminalShell('auto', 'linux')).toBe('unix')
  })

  it('builds spawn args for each resolved shell', () => {
    expect(terminalSpawnSpec('echo hi', 'cmd')).toEqual({
      resolved: 'cmd',
      bin: 'cmd.exe',
      args: ['/c', 'echo hi']
    })
    expect(terminalSpawnSpec('Get-ChildItem', 'powershell').args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-ChildItem'
    ])
    expect(terminalSpawnSpec('ls', 'bash')).toEqual({
      resolved: 'bash',
      bin: 'bash',
      args: ['-lc', 'ls']
    })
  })
})

describe('Windows terminal executeTool behavior', () => {
  it('intercepts Unix primaries before spawn on win32 when shell is cmd', async () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-term-unix-'))
    const signal = new AbortController().signal
    const content = await toolTerminal(dir, 'ls -la', signal, { shell: 'cmd' })
    expect(content).toMatch(/Unsupported Unix command/)
    expect(content).toMatch(/dir/)
    expect(content).toMatch(/exit_code: 1/)
  })

  it('treats findstr no-match as soft success on win32 with cmd', async () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-term-findstr-'))
    writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8')
    const signal = new AbortController().signal
    const content = await toolTerminal(dir, 'findstr /i zzznomatch123 a.txt', signal, {
      shell: 'cmd'
    })
    expect(content).toMatch(/findstr: no matches/)
    expect(content).toMatch(/shell: cmd/)
    expect(content).toMatch(/exit_code: 1/)
  })
})

describe('tool success logging', () => {
  const prev = getLoggerBackend()
  const info = vi.fn()

  afterEach(() => {
    setLoggerBackend(prev)
    info.mockReset()
  })

  it('logs one info line on successful tool execution', async () => {
    setLoggerBackend({
      log: (level, message, fields) => {
        if (level === 'info') info({ message, fields })
      }
    })
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tool-ok-log-'))
    writeFileSync(join(dir, 'r.txt'), 'payload', 'utf8')
    const signal = new AbortController().signal
    const result = await executeTool(
      'read',
      JSON.stringify({ path: 'r.txt' }),
      dir,
      signal
    )
    expect(result.ok).toBe(true)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0].message).toBe('Tool succeeded')
    expect(info.mock.calls[0][0].fields).toMatchObject({
      scope: 'tools',
      tool: 'read'
    })
  })
})
