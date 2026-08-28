import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, RunGoal, RunLoop } from '@shared/ipc'
import { pushToast } from '@renderer/lib/ui'

const POLL_MS = 2000
const LIVE_POLL_MS = 500

function parseGoal(content: string | null | undefined): RunGoal | null {
  if (!content?.trim()) return null
  try {
    const raw = JSON.parse(content) as Partial<RunGoal>
    if (typeof raw.objective !== 'string' || !raw.objective.trim()) return null
    if (raw.status !== 'active' && raw.status !== 'paused' && raw.status !== 'complete') return null
    if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') return null
    return {
      objective: raw.objective,
      status: raw.status,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(typeof raw.continueCount === 'number' ? { continueCount: raw.continueCount } : {})
    }
  } catch {
    return null
  }
}

function parseLoop(content: string | null | undefined): RunLoop | null {
  if (!content?.trim()) return null
  try {
    const raw = JSON.parse(content) as Partial<RunLoop>
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) return null
    if (typeof raw.intervalMs !== 'number') return null
    if (raw.status !== 'armed' && raw.status !== 'stopped') return null
    if (typeof raw.nextAt !== 'string') return null
    return {
      prompt: raw.prompt,
      intervalMs: raw.intervalMs,
      status: raw.status,
      nextAt: raw.nextAt,
      ...(typeof raw.lastTickAt === 'string' ? { lastTickAt: raw.lastTickAt } : {})
    }
  } catch {
    return null
  }
}

export function useRunGoal(opts: {
  workspacePath: string | null
  runId: string | null
  running?: boolean
  active?: boolean
}): {
  goal: RunGoal | null
  loop: RunLoop | null
  pause: () => Promise<boolean>
  resume: () => Promise<boolean>
  complete: () => Promise<boolean>
  stopLoop: () => Promise<boolean>
} {
  const { workspacePath, runId, running = false, active = true } = opts
  const [goal, setGoal] = useState<RunGoal | null>(null)
  const [loop, setLoop] = useState<RunLoop | null>(null)
  const loadSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!workspacePath || !runId || !window.vyotiq?.readRunArtifact) {
      if (seq !== loadSeqRef.current) return
      setGoal(null)
      setLoop(null)
      return
    }
    const [goalRes, loopRes] = await Promise.all([
      window.vyotiq.readRunArtifact({ workspacePath, runId, name: 'goal.json' }),
      window.vyotiq.readRunArtifact({ workspacePath, runId, name: 'loop.json' })
    ])
    if (seq !== loadSeqRef.current) return
    setGoal(goalRes.ok ? parseGoal(goalRes.data.content) : null)
    setLoop(loopRes.ok ? parseLoop(loopRes.data.content) : null)
  }, [workspacePath, runId])

  useEffect(() => {
    void load()
  }, [load])

  const hasVisibleGoal = Boolean(goal && goal.status !== 'complete')
  const hasArmedLoop = loop?.status === 'armed'
  useEffect(() => {
    if (!active || !workspacePath || !runId) return
    const ms = running && (hasVisibleGoal || hasArmedLoop) ? LIVE_POLL_MS : POLL_MS
    const id = window.setInterval(() => {
      void load()
    }, ms)
    return () => window.clearInterval(id)
  }, [active, workspacePath, runId, running, hasVisibleGoal, hasArmedLoop, load])

  useEffect(() => {
    if (!runId || !window.vyotiq?.onChatEvent) return
    return window.vyotiq.onChatEvent((event: AgentEvent) => {
      if (event.runId !== runId) return
      if (event.type === 'goal_update') {
        setGoal(event.goal)
      }
      if (event.type === 'loop_update') setLoop(event.loop)
    })
  }, [runId])

  const pause = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || !runId || !window.vyotiq?.setGoalStatus) return false
    const res = await window.vyotiq.setGoalStatus({
      workspacePath,
      runId,
      action: 'pause'
    })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return false
    }
    setGoal(res.data.goal)
    return true
  }, [workspacePath, runId])

  const resume = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || !runId || !window.vyotiq?.setGoalStatus) return false
    const res = await window.vyotiq.setGoalStatus({
      workspacePath,
      runId,
      action: 'resume'
    })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return false
    }
    setGoal(res.data.goal)
    return true
  }, [workspacePath, runId])

  const complete = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || !runId || !window.vyotiq?.setGoalStatus) return false
    const res = await window.vyotiq.setGoalStatus({
      workspacePath,
      runId,
      action: 'complete'
    })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return false
    }
    setGoal(res.data.goal)
    return true
  }, [workspacePath, runId])

  const stopLoop = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || !runId || !window.vyotiq?.setLoop) return false
    const res = await window.vyotiq.setLoop({
      workspacePath,
      runId,
      action: 'stop'
    })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return false
    }
    setLoop(res.data.loop)
    return true
  }, [workspacePath, runId])

  return { goal, loop, pause, resume, complete, stopLoop }
}
