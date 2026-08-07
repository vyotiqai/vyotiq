import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Tooltip, cn } from '@renderer/lib/ui'

/** Compact dock toolbar control — avoids Button's min-h-8 base. */
export const DOCK_TOOLBAR_BTN =
  'inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md border border-border bg-surface px-2 text-caption leading-none text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'

export const DOCK_TOOLBAR_ICON_BTN =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-caption leading-none text-muted hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'

/** Single-border split control so primary + chevron share one height box. */
export function DockSplitButton({
  className,
  primaryClassName,
  menuClassName,
  primaryLabel,
  primaryIcon,
  primaryDisabled,
  onPrimaryClick,
  menuOpen,
  onMenuToggle,
  menuAriaLabel,
  menu
}: {
  className?: string
  primaryClassName?: string
  menuClassName?: string
  primaryLabel: ReactNode
  primaryIcon?: ReactNode
  primaryDisabled?: boolean
  onPrimaryClick: () => void
  menuOpen: boolean
  onMenuToggle: () => void
  menuAriaLabel: string
  menu?: ReactNode
}) {
  return (
    <div className={cn('relative inline-flex shrink-0', className)}>
      <div className="inline-flex h-6 overflow-hidden rounded-md border border-border bg-surface">
        <button
          type="button"
          className={cn(
            'inline-flex h-full items-center gap-1 px-2 text-caption leading-none text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]',
            primaryClassName
          )}
          disabled={primaryDisabled}
          onClick={onPrimaryClick}
        >
          {primaryIcon}
          <span className="whitespace-nowrap">{primaryLabel}</span>
        </button>
        <Tooltip content={menuAriaLabel}>
          <button
            type="button"
            className={cn(
              'inline-flex h-full w-6 shrink-0 items-center justify-center border-l border-border text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]',
              menuClassName
            )}
            disabled={primaryDisabled}
            aria-label={menuAriaLabel}
            aria-expanded={menuOpen}
            onClick={onMenuToggle}
          >
            <Icon name="chevron" size={10} />
          </button>
        </Tooltip>
      </div>
      {menu}
    </div>
  )
}

export function EmptyPanel({
  icon,
  title,
  body,
  actions
}: {
  icon: 'terminal' | 'file' | 'branch' | 'pullRequest' | 'stack' | 'listTodo'
  title: string
  body: string
  actions?: ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Icon name={icon} size={28} className="mb-3 text-muted/50" />
      <p className="text-xs font-medium text-fg/80">{title}</p>
      <p className="mt-1 max-w-[16rem] text-caption leading-relaxed text-muted">{body}</p>
      {actions ? (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}
