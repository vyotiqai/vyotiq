import { useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Tooltip, cn } from '@renderer/lib/ui'
import {
  RUN_LIST_CAP,
  SIDEBAR_INDENT,
  SIDEBAR_PAD_X,
  SIDEBAR_ROW,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_HOVER,
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_WORKSPACE_GROUP,
  SIDEBAR_WORKSPACE_ROW,
  SIDEBAR_WORKSPACE_ROW_ACTIVE,
  SIDEBAR_WORKSPACE_ROW_HOVER
} from '@renderer/lib/utils/layout'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { ChatRow } from './ChatRow'
import { InlineConfirmActions } from './InlineConfirmActions'
import type { WorkspaceSidebarGroup } from './types'

function WorkspaceHeader({
  name,
  path,
  active,
  expanded,
  hasActivity,
  onToggle,
  onSelectWorkspace,
  onCloseWorkspace
}: {
  name: string
  path: string
  active: boolean
  expanded: boolean
  hasActivity: boolean
  onToggle: () => void
  onSelectWorkspace: () => void
  onCloseWorkspace: () => void
}) {
  const [confirmingClose, setConfirmingClose] = useState(false)

  const closeConfirmLabel = hasActivity
    ? `Stop active runs and close ${name}`
    : `Confirm close ${name}`

  return (
    <div
      className={cn(
        'group flex items-center gap-1',
        SIDEBAR_WORKSPACE_ROW,
        active
          ? SIDEBAR_WORKSPACE_ROW_ACTIVE
          : cn('text-muted', SIDEBAR_WORKSPACE_ROW_HOVER)
      )}
    >
      <button
        type="button"
        className="app-region-no-drag inline-grid size-6 shrink-0 place-items-center rounded-md vy-transition hover:bg-surface/50"
        aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
        aria-expanded={expanded}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        <span className="relative inline-flex size-4 items-center justify-center">
          <Icon
            name="folder"
            size={13}
            className="absolute opacity-80 group-hover:opacity-0 vy-transition"
            aria-hidden="true"
          />
          <Icon
            name={expanded ? 'chevron' : 'chevronRight'}
            size={13}
            className="absolute opacity-0 group-hover:opacity-100 vy-transition"
            aria-hidden="true"
          />
        </span>
      </button>
      <button
        type="button"
        className="app-region-no-drag flex min-w-0 flex-1 items-center gap-1 text-left"
        title={path}
        onClick={onSelectWorkspace}
      >
        {hasActivity ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-fg motion-safe:animate-pulse"
            title="Active run in workspace"
            aria-hidden
          />
        ) : null}
        <span className="truncate font-medium">{name}</span>
      </button>
      {confirmingClose ? (
        <div className="app-region-no-drag">
          <InlineConfirmActions
            size="sm"
            confirmLabel={closeConfirmLabel}
            cancelLabel={`Cancel close ${name}`}
            onConfirm={() => {
              setConfirmingClose(false)
              onCloseWorkspace()
            }}
            onCancel={() => setConfirmingClose(false)}
          />
        </div>
      ) : (
        <Tooltip content={`Close ${name}`}>
          <button
            type="button"
            className="app-region-no-drag inline-grid size-6 place-items-center rounded-md text-muted opacity-0 vy-transition hover:bg-surface/70 hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={`Close ${name}`}
            onClick={(e) => {
              e.stopPropagation()
              setConfirmingClose(true)
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

export function ChatList({
  workspaceReady,
  sessionQuery,
  filteredRunsCount,
  workspaceGroups,
  onToggleWorkspace,
  onSwitchWorkspace,
  onCloseWorkspace,
  onAddWorkspace,
  activeRuns,
  workspaceHasBackgroundRun,
  onDismissRunsError,
  onSelectRun,
  onRenameRun,
  onDeleteRun
}: {
  workspaceReady: boolean
  sessionQuery: string
  filteredRunsCount: number
  workspaceGroups: WorkspaceSidebarGroup[]
  onToggleWorkspace: (path: string) => void
  onSwitchWorkspace: (path: string) => void
  onCloseWorkspace: (path: string) => void
  onAddWorkspace: () => void
  activeRuns: { runId: string; workspacePath: string }[]
  workspaceHasBackgroundRun: (path: string) => boolean
  onDismissRunsError?: (path?: string) => void
  onSelectRun: (path: string, runId: string) => void
  onRenameRun: (path: string, runId: string, goal: string) => void
  onDeleteRun: (path: string, runId: string) => void
}) {
  return (
    <div className={cn(SIDEBAR_PAD_X, 'py-2')} role="region" aria-label="Workspace sessions">
      {!workspaceReady ? (
        <p className="m-0 py-6 text-center text-sm text-muted">
          Open a workspace to see chats
        </p>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <p className={SIDEBAR_SECTION_LABEL}>Workspaces</p>
            <button
              type="button"
              className="app-region-no-drag inline-grid size-7 place-items-center rounded-md text-muted vy-transition hover:bg-surface/50 hover:text-fg"
              aria-label="Add workspace"
              title="Add workspace"
              onClick={onAddWorkspace}
            >
              <Icon name="folderPlus" size={14} />
            </button>
          </div>

          {filteredRunsCount === 0 && sessionQuery.trim() ? (
            <p className="m-0 py-4 text-center text-sm text-muted">
              No matching chats
            </p>
          ) : null}

          <div className="flex flex-col gap-2 pb-1">
            {workspaceGroups.map((workspace) => {
              const searchActive = Boolean(sessionQuery.trim())
              const globalSearchEmpty = searchActive && filteredRunsCount === 0

              return (
              <div key={workspace.path} className={SIDEBAR_WORKSPACE_GROUP}>
                <WorkspaceHeader
                  name={workspace.label}
                  path={workspace.path}
                  active={workspace.isActiveWorkspace}
                  expanded={workspace.expanded}
                  hasActivity={
                    workspaceHasBackgroundRun(workspace.path) ||
                    activeRuns.some((r) => workspacePathsEqual(r.workspacePath, workspace.path))
                  }
                  onToggle={() => onToggleWorkspace(workspace.path)}
                  onSelectWorkspace={() => onSwitchWorkspace(workspace.path)}
                  onCloseWorkspace={() => onCloseWorkspace(workspace.path)}
                />

                {workspace.runsError ? (
                  <div
                    className={cn(
                      SIDEBAR_INDENT,
                      'mr-1 flex items-start gap-2 rounded-md border border-danger/20 bg-danger/5 px-2 py-1.5'
                    )}
                    role="alert"
                  >
                    <p className="m-0 min-w-0 flex-1 text-xs text-danger">{workspace.runsError}</p>
                    {onDismissRunsError ? (
                      <button
                        type="button"
                        className="shrink-0 text-xs text-muted vy-transition hover:text-fg"
                        onClick={() => onDismissRunsError(workspace.path)}
                      >
                        Dismiss
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {workspace.expanded ? (
                  workspace.runsLoaded === false && !workspace.runsError ? (
                    <div className={cn(SIDEBAR_INDENT, 'flex flex-col gap-1 py-1')} aria-busy="true" role="status">
                      <span className="sr-only">Loading chats…</span>
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className={cn(SIDEBAR_ROW, 'h-7 animate-pulse bg-surface')}
                          style={{ width: `${82 - i * 14}%` }}
                        />
                      ))}
                    </div>
                  ) : workspace.filteredRuns.length === 0 && !globalSearchEmpty ? (
                    <p className={cn(SIDEBAR_INDENT, 'py-1 text-xs text-secondary')}>No chats yet</p>
                  ) : workspace.filteredRuns.length > 0 ? (
                    <div className={cn(SIDEBAR_INDENT, 'flex flex-col gap-2')}>
                      {workspace.groupedRuns.map((group) => (
                        <div key={`${workspace.path}:${group.id}`}>
                          {(workspace.groupedRuns.length > 1 || group.label === 'Results') && (
                            <div className="flex items-center gap-2 px-1 py-1">
                              <p className={cn(SIDEBAR_SECTION_LABEL, 'shrink-0')}>
                                {group.label}
                              </p>
                              <div className="h-px min-w-0 flex-1 bg-border/40" aria-hidden />
                            </div>
                          )}
                          <div className="flex flex-col gap-px" role="list">
                            {group.runs.map((run) => (
                              <ChatRow
                                key={`${workspace.path}:${run.runId}`}
                                run={run}
                                active={workspace.activeRunId === run.runId}
                                onSelect={() => onSelectRun(workspace.path, run.runId)}
                                onRename={(goal) => onRenameRun(workspace.path, run.runId, goal)}
                                onDelete={() => onDeleteRun(workspace.path, run.runId)}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                      {workspace.runsCapped && !searchActive ? (
                        <p className="px-1 py-1.5 text-caption text-muted">
                          Showing {RUN_LIST_CAP} most recent
                        </p>
                      ) : null}
                    </div>
                  ) : null
                ) : null}
              </div>
            )})}
          </div>
        </>
      )}
    </div>
  )
}
