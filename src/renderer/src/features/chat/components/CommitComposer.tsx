import { cn } from '@renderer/lib/ui'
import type { GitChangedFile, GitStatus } from '@shared/ipc'

const PILL =
  'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] vy-transition'

/** Shared default commit message for Changes panel (and any legacy callers). */
export function defaultCommitMessage(
  files: Array<Pick<GitChangedFile, 'path'> | { path: string }>,
  fileCount = files.length
): string {
  const first = files[0]
  if (fileCount === 1 && first) {
    const base = first.path.includes('/') ? first.path.slice(first.path.lastIndexOf('/') + 1) : first.path
    return `Update ${base}`
  }
  return `Update ${fileCount} files`
}

export function defaultCommitMessageFromStatus(status: GitStatus): string {
  return defaultCommitMessage(status.files, status.fileCount)
}

/**
 * Shared commit message field + Commit / Commit & Push actions.
 * Canonical home is the Changes panel toolbar.
 */
export function CommitComposer({
  message,
  onMessageChange,
  busy,
  hasRemote,
  primaryPushes,
  onCommit,
  onCancel,
  className,
  inputClassName,
  compact = false
}: {
  message: string
  onMessageChange: (value: string) => void
  busy: boolean
  hasRemote: boolean
  /** When true, primary button is Commit & Push. */
  primaryPushes?: boolean
  onCommit: (push: boolean) => void
  onCancel?: () => void
  className?: string
  inputClassName?: string
  compact?: boolean
}) {
  const primaryPush = primaryPushes ?? hasRemote
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <input
        type="text"
        value={message}
        autoFocus
        className={
          inputClassName ??
          'min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-xs text-fg outline-none focus-visible:vy-focus-ring'
        }
        placeholder="Commit message"
        aria-label="Commit message"
        onChange={(event) => onMessageChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onCommit(primaryPush)
          if (event.key === 'Escape') onCancel?.()
        }}
      />
      <button
        type="button"
        className={cn(
          compact
            ? 'h-6 rounded-md px-2 text-[11px] text-fg hover:bg-surface-2'
            : cn(PILL, 'text-fg hover:bg-surface-2'),
          'disabled:opacity-50'
        )}
        disabled={busy || !message.trim()}
        onClick={() => onCommit(false)}
      >
        Commit
      </button>
      {hasRemote ? (
        <button
          type="button"
          className={cn(
            compact
              ? 'h-6 rounded-md px-2 text-[11px] text-fg hover:bg-surface-2'
              : cn(PILL, 'text-fg hover:bg-surface-2'),
            'disabled:opacity-50'
          )}
          disabled={busy || !message.trim()}
          onClick={() => onCommit(true)}
        >
          Commit &amp; Push
        </button>
      ) : null}
    </div>
  )
}
