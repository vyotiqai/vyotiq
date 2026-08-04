import { type ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { cn } from './cn'

export function NavItem({
  label,
  icon,
  active,
  onClick,
  current,
  pressed,
  disabled,
  title,
  variant = 'sidebar',
  className = '',
  trailing,
  dense
}: {
  label: string
  icon?: IconName
  active?: boolean
  onClick: () => void
  current?: boolean
  pressed?: boolean
  disabled?: boolean
  title?: string
  variant?: 'sidebar' | 'settings' | 'icon'
  className?: string
  trailing?: ReactNode
  /** Slightly tighter padding for dense lists. */
  dense?: boolean
}) {
  if (variant === 'icon') {
    return (
      <button
        type="button"
        className={cn(
          'app-region-no-drag inline-grid size-8 place-items-center rounded-md vy-transition',
          'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]',
          active
            ? 'bg-surface text-fg-strong'
            : 'text-secondary hover:bg-surface/70 hover:text-fg active:bg-surface',
          className
        )}
        aria-label={label}
        aria-current={current ? 'page' : undefined}
        aria-pressed={pressed}
        disabled={disabled}
        title={title ?? label}
        onClick={onClick}
      >
        {icon ? <Icon name={icon} size={18} weight={active ? 'fill' : 'bold'} /> : null}
      </button>
    )
  }

  return (
    <button
      type="button"
      className={cn(
        'app-region-no-drag rounded-md text-left text-sm tracking-[var(--vy-tracking-tight)] vy-transition',
        'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)] disabled:hover:bg-transparent disabled:hover:text-secondary',
        dense ? 'px-2 py-1.5' : 'px-2.5 py-[7px]',
        variant === 'sidebar'
          ? 'flex w-full items-center gap-2.5'
          : variant === 'settings'
            ? 'inline-flex shrink-0 items-center gap-2 sm:flex sm:w-full'
            : 'shrink-0 sm:w-full',
        active
          ? 'bg-surface-2 text-fg-strong'
          : 'text-secondary hover:bg-surface hover:text-fg active:bg-surface-2',
        className
      )}
      aria-current={current ? 'page' : undefined}
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {icon ? (
        <Icon
          name={icon}
          size={18}
          weight={active ? 'fill' : 'bold'}
          className="shrink-0"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}

export function SettingsNavItem({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'shrink-0 rounded-md px-2.5 py-[6px] text-left text-sm tracking-[var(--vy-tracking-tight)] vy-transition sm:w-full',
        active ? 'bg-surface-2 text-fg-strong' : 'text-muted hover:bg-surface hover:text-fg'
      )}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
