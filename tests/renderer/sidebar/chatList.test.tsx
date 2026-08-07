/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatList } from '@renderer/app/sidebar/ChatList'
import { RUN_LIST_CAP } from '@shared/domain/runs'
import type { WorkspaceSidebarGroup } from '@renderer/app/sidebar/types'

afterEach(() => cleanup())

const workspaceGroup = (overrides: Partial<WorkspaceSidebarGroup> = {}): WorkspaceSidebarGroup => ({
  path: '/ws/demo',
  label: 'demo',
  isActiveWorkspace: true,
  expanded: true,
  filteredRuns: [],
  groupedRuns: [],
  runsCapped: false,
  runsError: null,
  runsLoaded: true,
  activeRunId: null,
  ...overrides
})

const noop = (): void => {}

describe('ChatList', () => {
  it('uses the shared section label for workspaces', () => {
    render(
      <ChatList
        workspaceReady
        sessionQuery=""
        filteredRunsCount={0}
        workspaceGroups={[workspaceGroup()]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    expect(screen.getByText('Workspaces')).toBeTruthy()
  })

  it('shows the search empty state once for global search misses', () => {
    render(
      <ChatList
        workspaceReady
        sessionQuery="missing"
        filteredRunsCount={0}
        workspaceGroups={[workspaceGroup({ filteredRuns: [], groupedRuns: [] })]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    expect(screen.getAllByText('No matching chats')).toHaveLength(1)
    const emptyState = screen.getByText('No matching chats')
    expect(emptyState.className).not.toContain('rounded-xl')
  })

  it('shows the dynamic runs cap footnote', () => {
    render(
      <ChatList
        workspaceReady
        sessionQuery=""
        filteredRunsCount={1}
        workspaceGroups={[
          workspaceGroup({
            filteredRuns: [
              {
                runId: 'run-1',
                goal: 'Ship sidebar',
                status: 'done',
                updatedAt: new Date().toISOString()
              }
            ],
            groupedRuns: [
              {
                id: 'today',
                label: 'Today',
                runs: [
                  {
                    runId: 'run-1',
                    goal: 'Ship sidebar',
                    status: 'done',
                    updatedAt: new Date().toISOString()
                  }
                ]
              }
            ],
            runsCapped: true
          })
        ]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    expect(screen.getByText(`Showing ${RUN_LIST_CAP} most recent`)).toBeTruthy()
  })
})
