import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import { RunLoopSchema, type RunLoop } from '../../shared/ipc'
import { atomicWriteJson } from '@main/storage/atomicWrite'
import { invalidateListRunsCache } from './runListCache'
import { appendEvent, loadStatus } from './state'
import { getRunInvokeId } from './runRegistry'
import { sendChatEventToRenderer } from './startAgentRun'
import { launchRunFollowUpOrStart, resolveRunWebContents } from './launchRunInvoke'
import { readGoal, registerGoalLoopDisarm } from './runGoal'
import { formatLoopStatusLine as formatLoopStatusLineShared } from '../../shared/goalRuntime'
import { isQuotaExhaustedMessage } from './quotaGate'
import { logger } from '../../shared/logger'

function loopPath(runDir: string): string {
  return join(runDir, 'loop.json')
}

function nowIso(): string {
  return new Date().toISOString()
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const meta = new Map<string, { workspacePath: string; runDir: string }>()

export function readLoop(runDir: string): RunLoop | null {
  const path = loopPath(runDir)
  if (!existsSync(path)) return null
  try {
    const parsed = RunLoopSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function writeLoop(runDir: string, loop: RunLoop): RunLoop {
  atomicWriteJson(loopPath(runDir), loop)
  invalidateListRunsCache()
  return loop
}

function emitLoopUpdate(
  workspacePath: string,
  runId: string,
  runDir: string,
  loop: RunLoop | null,
  wc?: WebContents | null
): void {
  const invokeId = getRunInvokeId(runId)
  const event = {
    type: 'loop_update' as const,
    runId,
    loop,
    ...(invokeId != null ? { invokeId } : {})
  }
  appendEvent(runDir, event)
  const target = resolveRunWebContents(wc)
  if (target) sendChatEventToRenderer(runId, event, invokeId ?? 1, target)
}

function clearTimer(runId: string): void {
  const timer = timers.get(runId)
  if (timer) clearTimeout(timer)
  timers.delete(runId)
}

function delayMs(loop: RunLoop): number {
  const target = Date.parse(loop.nextAt)
  if (!Number.isFinite(target)) return loop.intervalMs
  return Math.max(0, target - Date.now())
}

function schedule(runId: string, loop: RunLoop): void {
  clearTimer(runId)
  if (loop.status !== 'armed') return
  const info = meta.get(runId)
  if (!info) return
  const wait = delayMs(loop)
  const timer = setTimeout(() => {
    void onTick(runId)
  }, wait)
  timers.set(runId, timer)
}

async function onTick(runId: string): Promise<void> {
  const info = meta.get(runId)
  if (!info) return
  const loop = readLoop(info.runDir)
  if (!loop || loop.status !== 'armed') {
    clearTimer(runId)
    return
  }
  const goal = readGoal(info.runDir)
  // A completed goal terminates the loop; a paused goal holds without launching.
  if (goal && goal.status === 'complete') {
    clearTimer(runId)
    return
  }
  if (goal && goal.status === 'paused') {
    // Hold: re-check on the next interval instead of spawning a run, so the
    // loop naturally resumes once the goal is resumed.
    const timer = setTimeout(() => void onTick(runId), loop.intervalMs)
    timers.set(runId, timer)
    return
  }
  // Quota exhaustion is a billing gate, not an outage (quotaGate contract):
  // a relaunch on an exhausted plan re-stops instantly on the same terminal
  // error (run 6265fa90: 472 relaunches in ~4 min). Hold the loop on the next
  // interval instead of launching; a real Continue clears the persisted error.
  const persisted = loadStatus(info.runDir)
  if (persisted?.status === 'error' && isQuotaExhaustedMessage(persisted.error ?? '')) {
    const timer = setTimeout(() => void onTick(runId), loop.intervalMs)
    timers.set(runId, timer)
    return
  }
  const launched = launchRunFollowUpOrStart({
    workspacePath: info.workspacePath,
    runId,
    message: { role: 'user', content: loop.prompt }
  })
  if (!launched.ok) {
    logger.warn('Loop tick could not deliver prompt', {
      scope: 'loop',
      correlationId: runId,
      err: launched.error
    })
  }
  const next: RunLoop = {
    ...loop,
    lastTickAt: nowIso(),
    nextAt: new Date(Date.now() + loop.intervalMs).toISOString()
  }
  writeLoop(info.runDir, next)
  emitLoopUpdate(info.workspacePath, runId, info.runDir, next)
  schedule(runId, next)
}

export function armLoop(input: {
  workspacePath: string
  runId: string
  runDir: string
  prompt: string
  intervalMs: number
  wc?: WebContents | null
}): RunLoop {
  const loop: RunLoop = {
    prompt: input.prompt.trim(),
    intervalMs: input.intervalMs,
    status: 'armed',
    nextAt: new Date(Date.now() + input.intervalMs).toISOString()
  }
  writeLoop(input.runDir, loop)
  meta.set(input.runId, { workspacePath: input.workspacePath, runDir: input.runDir })
  schedule(input.runId, loop)
  emitLoopUpdate(input.workspacePath, input.runId, input.runDir, loop, input.wc)
  return loop
}

export function disarmLoop(
  runDir: string,
  runId?: string,
  opts?: { workspacePath?: string; wc?: WebContents | null }
): RunLoop | null {
  const current = readLoop(runDir)
  let id = runId
  if (!id) {
    for (const [key, value] of meta) {
      if (value.runDir === runDir) {
        id = key
        break
      }
    }
  }
  const info = id ? meta.get(id) : undefined
  if (id) {
    clearTimer(id)
    meta.delete(id)
  }
  if (!current || current.status === 'stopped') return current
  const next = writeLoop(runDir, { ...current, status: 'stopped' })
  const workspacePath = opts?.workspacePath ?? info?.workspacePath
  if (workspacePath && id) {
    emitLoopUpdate(workspacePath, id, runDir, next, opts?.wc)
  }
  return next
}

export function rearmLoopFromDisk(workspacePath: string, runId: string, runDir: string): RunLoop | null {
  const loop = readLoop(runDir)
  if (!loop || loop.status !== 'armed') return loop
  const next: RunLoop = {
    ...loop,
    nextAt:
      Date.parse(loop.nextAt) > Date.now()
        ? loop.nextAt
        : new Date(Date.now() + loop.intervalMs).toISOString()
  }
  writeLoop(runDir, next)
  meta.set(runId, { workspacePath, runDir })
  schedule(runId, next)
  return next
}

export const formatLoopStatusLine = formatLoopStatusLineShared

registerGoalLoopDisarm((runDir) => {
  disarmLoop(runDir)
})
