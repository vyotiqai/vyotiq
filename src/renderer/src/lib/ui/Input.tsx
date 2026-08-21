import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from './cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...props }, ref) {
    return (
      <input
        ref={ref}
        data-vy-text-entry
        className={cn(
          'min-h-[var(--vy-control-min-h)] w-full rounded-md border border-border bg-surface px-[var(--vy-control-px)] text-sm text-fg placeholder:text-muted',
          'hover:border-border-strong',
          'focus-visible:border-border-strong focus-visible:vy-focus-ring',
          'disabled:vy-disabled-state disabled:hover:border-border',
          'vy-transition',
          className
        )}
        {...props}
      />
    )
  }
)
