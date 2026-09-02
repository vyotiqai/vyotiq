import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-loop-quota-${process.pid}-${Date.now()}`)
const launchMock = vi.hoisted(() => vi.fn(() => ({ ok: true as const })))
const workspaceState = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

vi.mock('@main/agent/launchRunInvoke', () => ({
  launchRunFollowUpOrStart: (...args: unknown[]) => launchMock(...args),
  resolveRunWebContents: () => null
}))

vi.mock('@main/agent/startAgentRun', () => ({
  sendChatEventToRenderer: vi.fn()
}))

import { armLoop, disarmLoop, readLoop } from '@main/agent/runLoopScheduler'
import { createRun } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'

const LOOP_INTERVAL_MS = 30_000 // RunLoopSchema min

describe('armed prompt loop during quota exhaustion', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-loop-quota-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    workspaceState.path = workspace
    launchMock.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    workspaceState.path = ''
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  const setStatus = (runId: string, patch: Record<string, unknown>): void => {
    const statusPath = join(resolveRunDir(workspace, runId), 'status.json')
    writeFileSync(
      statusPath,
      JSON.stringify({ ...JSON.parse(readFileSync(statusPath, 'utf8')), ...patch })
    )
  }

  it('holds and re-checks instead of relaunching while the persisted stop is quota exhaustion', async () => {
    // Run 6265fa90 (2026-09-01): the armed prompt loop relaunched the same
    // exhausted plan on every tick and re-stopped instantly on the same
    // billing-gate error. quotaGate's contract is "no automatic relaunch" —
    // the loop tick must honor it too and hold until a real Continue clears
    // the persisted error.
    const runId = 'loop-quota'
    createRun(workspace, runId, 'chat')
    const runDir = resolveRunDir(workspace, runId)
    setStatus(runId, {
      status: 'error',
      error: 'Provider weekly usage limit reached (quota exhausted, resets in 6 days).'
    })

    armLoop({ workspacePath: workspace, runId, runDir, prompt: 'continue the goal', intervalMs: LOOP_INTERVAL_MS })
    expect(readLoop(runDir)?.status).toBe('armed')

    // Hold-and-recheck: the quota tick must not launch and must re-arm itself.
    await vi.advanceTimersByTimeAsync(LOOP_INTERVAL_MS)
    expect(launchMock).not.toHaveBeenCalled()
    expect(readLoop(runDir)?.status).toBe('armed')

    // A user Continue clears the persisted quota message → next tick launches.
    setStatus(runId, { status: 'error', error: 'Circuit open for http:opencode.ai' })
    await vi.advanceTimersByTimeAsync(LOOP_INTERVAL_MS)
    expect(launchMock).toHaveBeenCalled()
    disarmLoop(runDir, runId, { workspacePath: workspace })
  })
})
