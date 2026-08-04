import { cn } from './cn'
import { Icon } from '@renderer/lib/icons'
import { dismissToast, useToasts, type ToastKind } from './toastStore'

const KIND_CLASSES: Record<ToastKind, string> = {
  info: 'border-border bg-surface text-fg',
  success: 'border-success/40 bg-surface text-fg',
  error: 'border-danger/50 bg-surface text-fg'
}

const KIND_ICON: Record<ToastKind, 'check' | 'warning' | 'sparkles'> = {
  info: 'sparkles',
  success: 'check',
  error: 'warning'
}

/** Fixed bottom-right toast stack — mount once at the app root. */
export function ToastHost() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-lg',
            KIND_CLASSES[toast.kind]
          )}
        >
          <Icon
            name={KIND_ICON[toast.kind]}
            size={14}
            className={cn(
              'mt-0.5 shrink-0',
              toast.kind === 'error' ? 'text-danger' : toast.kind === 'success' ? 'text-success' : 'text-tertiary'
            )}
          />
          <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">
            {toast.message}
          </span>
          <button
            type="button"
            aria-label="Dismiss notification"
            className="shrink-0 rounded-sm p-0.5 text-tertiary vy-transition hover:text-fg"
            onClick={() => dismissToast(toast.id)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
