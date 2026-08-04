import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ ...DEFAULT_SETTINGS })
}))

import { executeTool } from '@main/agent/tools'
import { resetTerminalSessionsForTests } from '@main/agent/tools/terminalSessions'

/**
 * End-to-end terminal coverage through executeTool: schema coercion,
 * foreground runs, and the background session_id lifecycle. Uses only
 * commands that exist on every platform shell (echo / node -e).
 */
describe('executeTool terminal', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-terminal-exec-'))
  })

  afterEach(async () => {
    resetTerminalSessionsForTests()
    // tree-kill is async — give long-running children a beat to exit before rm.
    await new Promise((r) => setTimeout(r, 400))
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 400))
      }
    }
  })

  it('runs a foreground command and reports exit code', async () => {
    const result = await executeTool(
      'terminal',
      JSON.stringify({ command: 'echo vyotiq-terminal-ok' }),
      workspace,
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('vyotiq-terminal-ok')
    expect(result.content).toContain('exit_code: 0')
  })

  it('rejects invalid args through the schema gate', async () => {
    const result = await executeTool(
      'terminal',
      JSON.stringify({ command: 'echo hi', block_until_ms: -5 }),
      workspace,
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
  })

  it('background sessions require run ownership', async () => {
    const result = await executeTool(
      'terminal',
      JSON.stringify({ command: 'echo bg', block_until_ms: 0 }),
      workspace,
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/run ownership/i)
  })

  it('starts a background session and polls it to completion', async () => {
    const signal = new AbortController().signal
    const context = { runId: 'term-run-1', invokeId: 1 }

    const started = await executeTool(
      'terminal',
      JSON.stringify({
        command: 'node -e "console.log(\'vyotiq-bg-done\')"',
        block_until_ms: 0
      }),
      workspace,
      signal,
      context
    )
    expect(started.ok).toBe(true)
    const sessionId = started.content.match(/session_id: ([0-9a-f-]{36})/)?.[1]
    expect(sessionId).toBeTruthy()
    expect(started.content).toMatch(/status: (running|done|pattern_matched)/)

    const polled = await executeTool(
      'terminal',
      JSON.stringify({ session_id: sessionId, block_until_ms: 10_000 }),
      workspace,
      signal,
      context
    )
    expect(polled.ok).toBe(true)
    expect(polled.content).toContain('vyotiq-bg-done')
    expect(polled.content).toContain('status: done')
    expect(polled.content).toContain('exit_code: 0')
  }, 20_000)

  it('poll with a pattern returns early on match', async () => {
    const signal = new AbortController().signal
    const context = { runId: 'term-run-2', invokeId: 2 }

    const started = await executeTool(
      'terminal',
      JSON.stringify({
        command: 'node -e "console.log(\'vyotiq-marker\'); setInterval(() => {}, 1000)"',
        block_until_ms: 0
      }),
      workspace,
      signal,
      context
    )
    expect(started.ok).toBe(true)
    const sessionId = started.content.match(/session_id: ([0-9a-f-]{36})/)?.[1]
    expect(sessionId).toBeTruthy()

    const polled = await executeTool(
      'terminal',
      JSON.stringify({ session_id: sessionId, block_until_ms: 10_000, pattern: 'vyotiq-marker' }),
      workspace,
      signal,
      context
    )
    expect(polled.content).toContain('status: pattern_matched')
    expect(polled.content).toContain('vyotiq-marker')
  }, 20_000)

  it('rejects a session poll owned by a different run', async () => {
    const signal = new AbortController().signal
    const started = await executeTool(
      'terminal',
      JSON.stringify({ command: 'node -e "setInterval(() => {}, 1000)"', block_until_ms: 0 }),
      workspace,
      signal,
      { runId: 'term-run-3', invokeId: 3 }
    )
    const sessionId = started.content.match(/session_id: ([0-9a-f-]{36})/)?.[1]
    expect(sessionId).toBeTruthy()

    const foreign = await executeTool(
      'terminal',
      JSON.stringify({ session_id: sessionId, block_until_ms: 0 }),
      workspace,
      signal,
      { runId: 'someone-else', invokeId: 9 }
    )
    expect(foreign.ok).toBe(false)
    expect(foreign.content).toMatch(/does not belong to run/i)
  }, 20_000)
})
