import { type ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { SIDEBAR_NAV_ACTIVE } from '@renderer/lib/utils/layout'
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
  const isActive = active ?? current

  if (variant === 'icon') {
    return (
      <button
        type="button"
        className={cn(
          'app-region-no-drag inline-grid size-8 place-items-center rounded-lg vy-transition focus-visible:vy-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]',
          isActive ? SIDEBAR_NAV_ACTIVE : 'text-secondary hover:bg-surface/60 hover:text-fg active:bg-surface',
          className
        )}
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        aria-pressed={pressed}
        disabled={disabled}
        title={title ?? label}
        onClick={onClick}
      >
        {icon ? <Icon name={icon} size={18} weight={isActive ? 'fill' : 'bold'} /> : null}
      </button>
    )
  }

  return (
    <button
      type="button"
      className={cn(
        'app-region-no-drag rounded-lg text-left text-sm tracking-[var(--vy-tracking-tight)] vy-transition focus-visible:vy-focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)] disabled:hover:bg-transparent disabled:hover:text-secondary',
        dense ? 'px-2 py-1.5' : 'px-2.5 py-2',
        variant === 'sidebar'
          ? 'flex w-full items-center gap-2'
          : variant === 'settings'
            ? 'inline-flex shrink-0 items-center gap-2 sm:flex sm:w-full'
            : 'shrink-0 sm:w-full',
        isActive ? SIDEBAR_NAV_ACTIVE : 'text-secondary hover:bg-surface/50 hover:text-fg active:bg-surface',
        className
      )}
      aria-current={isActive ? 'page' : undefined}
      aria-pressed={pressed}
      disabled={disabled}
      title={title ?? label}
      onClick={onClick}
    >
      {icon ? (
        <Icon
          name={icon}
          size={18}
          weight={isActive ? 'fill' : 'bold'}
          className="shrink-0"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}
