import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  disposeTerminalSessionsForInvoke,
  getTerminalSession,
  pollTerminalSession,
  resetTerminalSessionsForTests,
  startBackgroundTerminal
} from '@main/agent/tools/terminalSessions'

describe('terminalSessions', () => {
  let cwd: string

  afterEach(() => {
    resetTerminalSessionsForTests()
    if (!cwd) return
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* Windows may briefly lock the temp cwd while child handles drain */
    }
  })

  it('starts a background command and polls until done', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-'))
    const signal = new AbortController().signal
    const command =
      process.platform === 'win32' ? 'cmd /c echo hello-bg' : 'echo hello-bg'

    const first = await startBackgroundTerminal({
      runId: 'run-1',
      invokeId: 1,
      workspaceRoot: cwd,
      command,
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      blockUntilMs: 5_000
    })
    expect(first).toMatch(/session_id:/)
    expect(first).toMatch(/hello-bg/)

    const sessionId = first.match(/^session_id:\s*(\S+)/m)?.[1]
    expect(sessionId).toBeTruthy()

    const polled = await pollTerminalSession({
      runId: 'run-1',
      invokeId: 1,
      sessionId: sessionId!,
      blockUntilMs: 2_000,
      signal
    })
    expect(polled).toContain(sessionId!)
    expect(polled).toMatch(/status:\s*(done|pattern_matched)/)
  }, 15_000)

  it('emits onOutput chunks while the session runs', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-out-'))
    const signal = new AbortController().signal
    const chunks: string[] = []
    const command =
      process.platform === 'win32' ? 'cmd /c echo stream-chunk' : 'echo stream-chunk'

    await startBackgroundTerminal({
      runId: 'run-1',
      invokeId: 1,
      workspaceRoot: cwd,
      command,
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      blockUntilMs: 5_000,
      onOutput: (c) => chunks.push(c.text)
    })
    expect(chunks.join('')).toMatch(/stream-chunk/)
  }, 15_000)

  it('enforces invoke ownership and disposes all child processes with the invoke', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-owner-'))
    const signal = new AbortController().signal
    const command =
      process.platform === 'win32'
        ? 'ping -n 30 127.0.0.1 > nul'
        : 'sleep 30'
    const first = await startBackgroundTerminal({
      runId: 'run-owner',
      invokeId: 7,
      workspaceRoot: cwd,
      command,
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      blockUntilMs: 0
    })
    const sessionId = first.match(/^session_id:\s*(\S+)/m)?.[1]
    expect(sessionId).toBeTruthy()
    await expect(
      pollTerminalSession({
        runId: 'other-run',
        invokeId: 1,
        sessionId: sessionId!,
        blockUntilMs: 0,
        signal
      })
    ).rejects.toThrow(/does not belong/i)

    expect(disposeTerminalSessionsForInvoke('run-owner', 7)).toBe(1)
    expect(getTerminalSession(sessionId!, 'run-owner', 7)).toBeUndefined()
    expect(getTerminalSession(sessionId!, 'other-run', 1)).toBeUndefined()
  }, 15_000)

  it('rejects an invented session id when polling', async () => {
    await expect(
      pollTerminalSession({
        runId: 'run-1',
        invokeId: 1,
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        blockUntilMs: 0,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/Unknown terminal session_id/i)
  })
})
