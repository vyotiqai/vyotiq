import { useMemo } from 'react'
import { groupRunsByRecency } from '@renderer/lib/utils/groupRunsByRecency'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { findByWorkspacePath, workspacePathsEqual } from '@shared/workspacePathMatch'
import { runSearchText } from './runTitle'
import type { WorkspaceSidebarGroup, WorkspaceSidebarRuns } from './types'

type UseSidebarChatsInput = {
  openPaths: string[]
  activePath: string | null
  sessionQuery: string
  runsByWorkspacePath: Record<string, WorkspaceSidebarRuns>
  expandedByPath: Record<string, boolean>
}

export function useSidebarChats({
  openPaths,
  activePath,
  sessionQuery,
  runsByWorkspacePath,
  expandedByPath
}: UseSidebarChatsInput) {
  const workspaceGroups = useMemo<WorkspaceSidebarGroup[]>(() => {
    const q = sessionQuery.trim().toLowerCase()
    return openPaths.map((path) => {
      const workspaceRuns = findByWorkspacePath(runsByWorkspacePath, path) ?? {
        runs: [],
        activeRunId: null
      }
      const filteredRuns = q
        ? workspaceRuns.runs.filter((r) => runSearchText(r).includes(q))
        : workspaceRuns.runs
      const groupedRuns = q
        ? filteredRuns.length
          ? [{ id: 'today' as const, label: 'Results', runs: filteredRuns }]
          : []
        : groupRunsByRecency(filteredRuns)
      const expanded = q
        ? true
        : expandedByPath[path] ??
          (activePath != null && workspacePathsEqual(path, activePath))
      return {
        path,
        label: formatWorkspaceName(path, path),
        isActiveWorkspace: activePath != null && workspacePathsEqual(path, activePath),
        expanded,
        filteredRuns,
        groupedRuns,
        runsCapped: workspaceRuns.runsCapped,
        runsError: workspaceRuns.runsError,
        runsLoaded: workspaceRuns.runsLoaded,
        activeRunId: workspaceRuns.activeRunId
      }
    })
  }, [activePath, expandedByPath, openPaths, runsByWorkspacePath, sessionQuery])

  const filteredRuns = useMemo(
    () => workspaceGroups.flatMap((group) => group.filteredRuns),
    [workspaceGroups]
  )

  return { filteredRuns, workspaceGroups }
}
