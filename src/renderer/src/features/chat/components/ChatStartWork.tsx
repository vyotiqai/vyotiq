import { cn } from '@renderer/lib/ui/cn'

export function ChatStartWork({
  label,
  onFill,
  align = 'center',
  className
}: {
  label: string
  onFill: () => void
  align?: 'center' | 'start'
  className?: string
}) {
  return (
    <div
      className={cn(align === 'center' ? 'mt-3 text-center' : 'mt-1', className)}
      data-chat-start-work=""
    >
      <button
        type="button"
        className="max-w-full text-caption leading-snug text-secondary transition-colors hover:text-fg [overflow-wrap:anywhere]"
        onClick={onFill}
      >
        {label}
      </button>
    </div>
  )
}
