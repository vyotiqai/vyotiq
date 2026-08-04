import { cn } from './cn'

/**
 * Compact track/thumb switch for menu rows (Ignore Whitespace, Word Wrap).
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  className
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  label?: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full vy-transition',
        checked ? 'bg-success' : 'bg-surface-2',
        className
      )}
      onClick={() => onCheckedChange(!checked)}
    >
      <span
        className={cn(
          'inline-block size-3 rounded-full bg-fg shadow vy-transition',
          checked ? 'translate-x-3.5' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}
