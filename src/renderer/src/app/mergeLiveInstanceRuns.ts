import type { RunSummary } from '@shared/ipc'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'

function liveInstanceStatus(
  phase: AgentInstanceUiState['phase']
): RunSummary['status'] {
  switch (phase) {
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    case 'started':
      return 'running'
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}

/** Merge disk-listed instance runs with live parent `agentInstances` (status + goal). */
export function mergeLiveInstanceRuns(
  listed: RunSummary[],
  agentInstances: Record<string, AgentInstanceUiState> | undefined,
  parentRunId: string | null
): RunSummary[] {
  if (!agentInstances || !parentRunId) return listed
  const byId = new Map(listed.map((run) => [run.runId, run]))
  for (const inst of Object.values(agentInstances)) {
    const status = liveInstanceStatus(inst.phase)
    const prior = byId.get(inst.instanceRunId)
    byId.set(inst.instanceRunId, {
      runId: inst.instanceRunId,
      status,
      updatedAt: prior?.updatedAt ?? new Date().toISOString(),
      goal: inst.goal ?? prior?.goal,
      parentRunId: prior?.parentRunId ?? parentRunId,
      inlineInstance: true,
      ...(inst.pathScope?.length
        ? { pathScope: inst.pathScope }
        : prior?.pathScope?.length
          ? { pathScope: prior.pathScope }
          : {}),
      ...(status === 'cancelled' && prior?.resumable ? { resumable: true as const } : {}),
      ...(status === 'error' && prior?.error ? { error: prior.error } : {})
    })
  }
  return [...byId.values()]
}
