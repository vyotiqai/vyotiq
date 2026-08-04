import { createContext, useContext } from 'react'
import type { AgentInteractionMode } from '@shared/ipc'

/** Active chat run identity for tool cards that load run-dir artifacts. */
export type RunSessionValue = {
  workspacePath: string | null
  runId: string | null
  agentMode?: AgentInteractionMode
}

const RunSessionContext = createContext<RunSessionValue>({
  workspacePath: null,
  runId: null,
  agentMode: undefined
})

export const RunSessionProvider = RunSessionContext.Provider

export function useRunSession(): RunSessionValue {
  return useContext(RunSessionContext)
}
