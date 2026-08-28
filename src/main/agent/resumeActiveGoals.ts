import { readdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import { getWorkspaces } from '../workspace/workspaces'
import { workspaceSessionsRoot, resolveRunDir } from '@main/storage/paths'
import { loadStatus } from './state'
import { readGoal } from './runGoal'
import { emitGoalUpdate } from './goalEvents'
import { rearmLoopFromDisk } from './runLoopScheduler'
import { launchRunFollowUpOrStart } from './launchRunInvoke'
import { formatGoalContinueMessage } from '../../shared/goalRuntime'
import { isActive } from './runRegistry'
import { logger } from '../../shared/logger'

let resumedOnce = false

export function resetGoalResumeForTests(): void {
  resumedOnce = false
}

export function resumeActiveGoalsAndLoops(wc: WebContents): void {
  if (resumedOnce) return
  resumedOnce = true
  const open = getWorkspaces().openPaths
  for (const workspacePath of open) {
    const root = workspaceSessionsRoot(workspacePath)
    if (!existsSync(root)) continue
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const runId = entry.name
      const runDir = join(root, runId)
      const status = loadStatus(runDir)
      if (!status || status.inlineInstance) continue

      const loop = rearmLoopFromDisk(workspacePath, runId, runDir)
      if (loop?.status === 'armed') {
        logger.info('Re-armed chat loop', { scope: 'loop', correlationId: runId })
      }

      const goal = readGoal(runDir)
      if (goal?.status !== 'active') continue
      if (isActive(runId)) continue

      const launched = launchRunFollowUpOrStart({
        workspacePath,
        runId,
        wc,
        mode: 'agent',
        message: {
          role: 'user',
          content: formatGoalContinueMessage(goal.objective)
        }
      })
      if (!launched.ok) {
        logger.warn('Failed to resume active goal', {
          scope: 'goal',
          correlationId: runId,
          err: launched.error
        })
        continue
      }
      emitGoalUpdate({
        workspacePath,
        runId,
        runDir: resolveRunDir(workspacePath, runId),
        goal,
        notice: `Resuming goal: ${goal.objective}`,
        wc
      })
    }
  }
}
