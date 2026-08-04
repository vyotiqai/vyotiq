import { type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'

const interactive =
  'vy-transition disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'

export const buttonVariants = {
  primary: cn(
    'rounded-md bg-accent text-accent-fg',
    'hover:bg-fg-strong active:opacity-90'
  ),
  subtle: cn(
    'rounded-md border border-border bg-surface text-fg',
    'hover:bg-surface-2 hover:border-border-strong active:bg-surface-2'
  ),
  ghost: cn('rounded-md bg-transparent text-fg', 'hover:bg-surface active:bg-surface-2')
} as const

const buttonBase = cn(
  'inline-flex min-h-8 items-center justify-center gap-1.5 px-3 text-sm tracking-[var(--vy-tracking)]',
  interactive
)

export function Button({
  variant = 'primary',
  children,
  className = '',
  type = 'button',
  pending = false,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonVariants
  children?: ReactNode
  /** Disables the control and marks it busy for assistive tech. */
  pending?: boolean
}) {
  const isDisabled = Boolean(disabled || pending)
  return (
    <button
      className={cn(buttonBase, buttonVariants[variant], className)}
      type={type}
      disabled={isDisabled}
      aria-busy={pending || undefined}
      aria-disabled={isDisabled || undefined}
      {...props}
    >
      {children}
    </button>
  )
}
