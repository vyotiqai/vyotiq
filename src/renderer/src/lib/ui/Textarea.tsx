import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from './cn'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = '', ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'max-h-40 min-h-[26px] w-full resize-none border-none bg-transparent py-1.5 text-sm leading-[1.4] tracking-[-0.006em] outline-none placeholder:text-muted',
          'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)] focus-visible:outline-none',
          className
        )}
        rows={1}
        {...props}
      />
    )
  }
)
