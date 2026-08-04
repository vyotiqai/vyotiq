import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import type { WorkspaceSwitcherProps } from './types'

function workspaceIsActive(
  path: string,
  activeRuns: { runId: string; workspacePath: string }[],
  workspaceHasBackgroundRun: (path: string) => boolean
): boolean {
  return (
    workspaceHasBackgroundRun(path) ||
    activeRuns.some((r) => workspacePathsEqual(r.workspacePath, path))
  )
}

function AddWorkspaceButton({
  onAdd,
  compact = true
}: {
  onAdd: () => void
  compact?: boolean
}) {
  return (
    <button
      type="button"
      className={cn(
        'shrink-0 text-muted vy-transition hover:text-fg',
        compact
          ? 'inline-grid size-6 place-items-center rounded hover:bg-surface'
          : 'flex items-center gap-1 rounded px-1 py-0.5 text-[11px] hover:bg-surface'
      )}
      aria-label="Add workspace"
      title="Add workspace"
      onClick={onAdd}
    >
      <Icon name="folderPlus" size={compact ? 12 : 11} />
      {!compact ? <span>Add</span> : null}
    </button>
  )
}

export function WorkspaceSwitcher({
  openPaths,
  activePath,
  activeRuns,
  onSwitch,
  onClose,
  onAdd,
  workspaceHasBackgroundRun,
  collapsed = false
}: WorkspaceSwitcherProps) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1">
        {openPaths.length > 0 ? (
          <div
            className="flex flex-col items-center gap-0.5"
            role="tablist"
            aria-label="Workspaces"
            aria-orientation="vertical"
            onKeyDown={(e) =>
              handleTabListKeyDown(e, {
                tabs: openPaths,
                activeId: activePath,
                onSelect: onSwitch
              })
            }
          >
            {openPaths.map((path) => {
              const active = activePath !== null && workspacePathsEqual(path, activePath)
              const name = formatWorkspaceName(path, path)
              const showDot = workspaceIsActive(path, activeRuns, workspaceHasBackgroundRun)
              return (
                <button
                  key={path}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  className={cn(
                    'relative inline-grid size-7 place-items-center rounded vy-transition',
                    active ? 'bg-surface text-fg' : 'text-muted hover:bg-surface/60 hover:text-fg'
                  )}
                  title={`${name} — Shift+click or right-click to close`}
                  aria-label={`${name}. Shift+click or right-click to close.`}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      e.preventDefault()
                      onClose(path)
                      return
                    }
                    onSwitch(path)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    onClose(path)
                  }}
                >
                  <Icon name="folder" size={14} />
                  {showDot ? (
                    <span className="absolute right-1 top-1 size-1 rounded-full bg-fg" aria-hidden />
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}
        <AddWorkspaceButton onAdd={onAdd} compact />
      </div>
    )
  }

  if (openPaths.length === 0) {
    return (
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] text-muted vy-transition hover:bg-surface hover:text-fg"
        onClick={onAdd}
      >
        <Icon name="folderPlus" size={14} />
        <span className="truncate">Add workspace</span>
      </button>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <div
        className="sidebar-scroll-x flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        role="tablist"
        aria-label="Workspaces"
        onKeyDown={(e) =>
          handleTabListKeyDown(e, {
            tabs: openPaths,
            activeId: activePath,
            onSelect: onSwitch
          })
        }
      >
        {openPaths.map((path) => {
          const active = activePath !== null && workspacePathsEqual(path, activePath)
          const name = formatWorkspaceName(path, path)
          const showDot = workspaceIsActive(path, activeRuns, workspaceHasBackgroundRun)
          return (
            <button
              key={path}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={cn(
                'min-w-0 shrink truncate rounded px-1 py-0.5 text-[11px] vy-transition',
                openPaths.length === 1 ? 'max-w-full flex-1' : 'max-w-[5.75rem]',
                active ? 'bg-surface text-fg' : 'text-muted hover:bg-surface/60 hover:text-fg'
              )}
              title={`${path} — Right-click to close`}
              onClick={() => onSwitch(path)}
              onContextMenu={(e) => {
                e.preventDefault()
                onClose(path)
              }}
            >
              <span className="inline-flex items-center gap-1">
                {showDot ? (
                  <span className="size-1 shrink-0 rounded-full bg-fg motion-safe:animate-pulse" aria-hidden />
                ) : (
                  <Icon name="folder" size={12} className="shrink-0 opacity-50" />
                )}
                <span className="truncate">{name}</span>
              </span>
            </button>
          )
        })}
      </div>
      <AddWorkspaceButton onAdd={onAdd} />
    </div>
  )
}
