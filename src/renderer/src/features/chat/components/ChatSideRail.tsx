import { IconButton, cn } from '@renderer/lib/ui'
import type { IconName } from '@renderer/lib/icons'
import { shortcutLabel, type ShortcutId } from '@renderer/lib/shortcuts'
import { CHAT_SIDE_RAIL_WIDTH, CHAT_STAGE_TOP_INSET, type ChatRightPanelId } from '@renderer/lib/utils/layout'
import { DOCK_PANELS } from '@renderer/lib/utils/dockPanels'
import { useRunTodos } from '../hooks/useRunTodos'
import { TasksRailButton } from './TasksFloatingList'

const RAIL_ICON_ACTIVE =
  'bg-surface text-fg ring-1 ring-inset ring-border/50 rounded-lg'

const PANEL_SHORTCUT: Partial<Record<ChatRightPanelId, ShortcutId>> = {
  files: 'panelFiles',
  browser: 'panelBrowser',
  terminal: 'panelTerminal',
  changes: 'panelChanges',
  plan: 'panelPlan',
  pr: 'panelPr'
}

/**
 * Plan rail slot: the standard doc-icon button until the run has tasks, then
 * the live tasks button itself (status icon + count + hover card) — never both.
 */
function PlanRailRow({
  open,
  baseLabel,
  title,
  docIcon,
  workspacePath,
  runId,
  running,
  onSelectPanel
}: {
  open: boolean
  baseLabel: string
  title: string
  docIcon: IconName
  workspacePath: string | null
  runId: string | null
  running: boolean
  onSelectPanel: (panel: ChatRightPanelId) => void
}) {
  const { data } = useRunTodos({
    workspacePath,
    runId,
    running,
    active: Boolean(workspacePath && runId),
    live: true
  })

  if (!data || data.items.length === 0) {
    return (
      <IconButton
        icon={docIcon}
        label={baseLabel}
        title={title}
        variant="ghost"
        size="sm"
        aria-pressed={open}
        className={cn('text-muted hover:text-fg', open && RAIL_ICON_ACTIVE)}
        onClick={() => onSelectPanel('plan')}
      />
    )
  }

  return (
    <TasksRailButton
      data={data}
      running={running}
      onOpenPlan={() => onSelectPanel('plan')}
      labelSuffix={` · ${baseLabel}`}
    />
  )
}

/**
 * Floating right rail for toggling chat secondary panels.
 * Overlays the pane edge so the transcript can scroll edge-to-edge (scrollbar
 * sits under the rail rather than stopping short of it).
 */
export function ChatSideRail({
  activePanel,
  onSelectPanel,
  onExpandPanels,
  workspacePath = null,
  runId = null,
  running = false,
  className
}: {
  activePanel: ChatRightPanelId | null
  onSelectPanel: (panel: ChatRightPanelId) => void
  /** Re-enter immersive when panels remain after collapsing from Agent. */
  onExpandPanels?: () => void
  workspacePath?: string | null
  runId?: string | null
  running?: boolean
  className?: string
}) {
  return (
    <aside
      className={cn(
        'pointer-events-none absolute inset-y-0 right-0 z-dropdown flex h-full flex-col items-center justify-start overflow-visible bg-gradient-to-l from-bg via-bg/70 to-transparent',
        CHAT_STAGE_TOP_INSET,
        CHAT_SIDE_RAIL_WIDTH,
        className
      )}
      data-chat-side-rail
      aria-label="Panels"
    >
      <div
        className="pointer-events-auto flex w-full flex-col items-center gap-1 py-0.5"
      >
        {DOCK_PANELS.map((item) => {
          const open = activePanel === item.id
          const chordId = PANEL_SHORTCUT[item.id]
          const baseLabel = open ? item.hideLabel : item.showLabel
          const title = chordId ? `${baseLabel} (${shortcutLabel(chordId)})` : baseLabel
          if (item.id !== 'plan') {
            return (
              <IconButton
                key={item.id}
                icon={item.icon}
                label={baseLabel}
                title={title}
                variant="ghost"
                size="sm"
                aria-pressed={open}
                className={cn('text-muted hover:text-fg', open && RAIL_ICON_ACTIVE)}
                onClick={() => onSelectPanel(item.id)}
              />
            )
          }
          return (
            <div key={item.id} className="relative" data-plan-rail-row>
              <PlanRailRow
                open={open}
                baseLabel={baseLabel}
                title={title}
                docIcon={item.icon}
                workspacePath={workspacePath}
                runId={runId}
                running={running}
                onSelectPanel={onSelectPanel}
              />
            </div>
          )
        })}
        {onExpandPanels ? (
          <IconButton
            icon="maximize"
            label="Expand panel"
            variant="ghost"
            size="sm"
            className="mt-0.5 text-muted hover:text-fg"
            onClick={onExpandPanels}
          />
        ) : null}
      </div>
    </aside>
  )
}
