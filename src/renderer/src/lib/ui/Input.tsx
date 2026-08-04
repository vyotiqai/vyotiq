import { type InputHTMLAttributes } from 'react'
import { cn } from './cn'

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'min-h-8 w-full rounded-md border border-border bg-surface px-2.5 text-sm tracking-[var(--vy-tracking)] text-fg placeholder:text-muted',
        'hover:border-border-strong',
        'focus-visible:border-border-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-focus',
        'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)] disabled:hover:border-border',
        'vy-transition',
        className
      )}
      {...props}
    />
  )
}
