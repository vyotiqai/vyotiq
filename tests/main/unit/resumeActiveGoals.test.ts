import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { WebContents } from 'electron'
import { formatGoalContinueMessage } from '@shared/goalRuntime'

const userData = join(tmpdir(), `vyotiq-goal-resume-${process.pid}-${Date.now()}`)
const launchMock = vi.hoisted(() => vi.fn(() => ({ ok: true as const })))
const rearmMock = vi.hoisted(() => vi.fn(() => null))
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

vi.mock('@main/workspace/workspaces', () => ({
  getWorkspaces: () => ({
    openPaths: workspaceState.path ? [workspaceState.path] : [],
    recentPaths: [],
    activePath: workspaceState.path || null
  })
}))

vi.mock('@main/agent/launchRunInvoke', () => ({
  launchRunFollowUpOrStart: (...args: unknown[]) => launchMock(...args),
  resolveRunWebContents: () => null
}))

vi.mock('@main/agent/runLoopScheduler', () => ({
  rearmLoopFromDisk: (...args: unknown[]) => rearmMock(...args)
}))

import { createRun } from '@main/agent/state'
import { createGoal, pauseGoalIfActive } from '@main/agent/runGoal'
import { resolveRunDir } from '@main/storage/paths'
import { resetGoalResumeForTests, resumeActiveGoalsAndLoops } from '@main/agent/resumeActiveGoals'

describe('resumeActiveGoalsAndLoops', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-goal-resume-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    workspaceState.path = workspace
    launchMock.mockClear()
    rearmMock.mockClear()
    resetGoalResumeForTests()
  })

  afterEach(() => {
    workspaceState.path = ''
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('resumes active root goals and re-arms loops; skips paused and inline', () => {
    const activeId = 'goal-active'
    const pausedId = 'goal-paused'
    const inlineId = 'goal-inline'
    createRun(workspace, activeId, 'chat')
    createGoal(resolveRunDir(workspace, activeId), 'make CI green')
    createRun(workspace, pausedId, 'chat')
    createGoal(resolveRunDir(workspace, pausedId), 'paused objective')
    pauseGoalIfActive(resolveRunDir(workspace, pausedId))
    createRun(workspace, inlineId, 'chat', {
      inlineInstance: true,
      parentRunId: activeId
    })
    createGoal(resolveRunDir(workspace, inlineId), 'child should not resume')

    resumeActiveGoalsAndLoops({ isDestroyed: () => false } as WebContents)

    expect(rearmMock).toHaveBeenCalledTimes(2)
    expect(launchMock).toHaveBeenCalledTimes(1)
    const launched = launchMock.mock.calls[0]?.[0] as {
      runId: string
      message: { content: string }
    }
    expect(launched.runId).toBe(activeId)
    expect(launched.message.content).toBe(formatGoalContinueMessage('make CI green'))
  })
})
