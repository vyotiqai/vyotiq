import { useCallback, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import type { GitStatus, GitStatusResult } from '@shared/ipc'
import { useGitStatus } from './useGitStatus'
import { defaultCommitMessageFromStatus } from './CommitComposer'

const PILL =
  'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] vy-transition'

export type GitChrome = {
  status: GitStatus | null
  result: GitStatusResult | null
  error: string | null
  ready: boolean
  /** True until the first gitStatus answer arrives. */
  loading: boolean
  busy: boolean
  notice: string | null
  noticeFailed: boolean
  refresh: () => void
  commit: (message: string, push: boolean, mode?: 'all' | 'staged') => Promise<boolean>
  stageAll: () => Promise<boolean>
  stagePaths: (paths: string[]) => Promise<boolean>
  unstagePaths: (paths: string[]) => Promise<boolean>
}

/**
 * The workspace's git state plus commit/stage actions for the Changes panel.
 */
export function useGitChrome(
  workspacePath: string | null,
  revision: number,
  enabled = true,
  deferStartupMs?: number
): GitChrome {
  const { status, result, error, loading, refresh } = useGitStatus(
    workspacePath,
    revision,
    enabled,
    deferStartupMs
  )
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeFailed, setNoticeFailed] = useState(false)

  const commit = useCallback(
    async (message: string, push: boolean, mode: 'all' | 'staged' = 'all'): Promise<boolean> => {
      if (!workspacePath || !message.trim() || busy) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      try {
        const commitResult = await window.vyotiq.gitCommit(
          workspacePath,
          message.trim(),
          push,
          mode
        )
        setNotice(commitResult.ok ? commitResult.data.detail : commitResult.error)
        setNoticeFailed(!commitResult.ok)
        return commitResult.ok
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [workspacePath, busy, refresh]
  )

  const stageAll = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || busy) return false
    setBusy(true)
    setNotice(null)
    setNoticeFailed(false)
    try {
      const stageResult = await window.vyotiq.gitStageAll(workspacePath)
      setNotice(stageResult.ok ? stageResult.data.detail : stageResult.error)
      setNoticeFailed(!stageResult.ok)
      return stageResult.ok
    } finally {
      setBusy(false)
      refresh()
    }
  }, [workspacePath, busy, refresh])

  const stagePaths = useCallback(
    async (paths: string[]): Promise<boolean> => {
      if (!workspacePath || busy || paths.length === 0) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      try {
        const stageResult = await window.vyotiq.gitStagePaths({ workspacePath, paths })
        setNotice(stageResult.ok ? stageResult.data.detail : stageResult.error)
        setNoticeFailed(!stageResult.ok)
        return stageResult.ok
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [workspacePath, busy, refresh]
  )

  const unstagePaths = useCallback(
    async (paths: string[]): Promise<boolean> => {
      if (!workspacePath || busy || paths.length === 0) return false
      setBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      try {
        const result = await window.vyotiq.gitUnstagePaths({ workspacePath, paths })
        setNotice(result.ok ? result.data.detail : result.error)
        setNoticeFailed(!result.ok)
        return result.ok
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [workspacePath, busy, refresh]
  )

  return {
    status,
    result,
    error,
    ready: !loading && result != null,
    loading,
    busy,
    notice,
    noticeFailed,
    refresh,
    commit,
    stageAll,
    stagePaths,
    unstagePaths
  }
}

/**
 * Compact working-tree summary that opens the Changes panel.
 * Commit / Keep / Discard actions live only in Changes.
 */
export function GitChangePills({
  chrome,
  onOpenChanges
}: {
  chrome: GitChrome
  onOpenChanges?: () => void
}) {
  const { status, ready } = chrome

  if (!ready || !status || status.fileCount === 0) return null

  return (
    <div className="pointer-events-auto flex flex-col items-start gap-1.5">
      <div className="flex items-center gap-1.5 text-tertiary">
        <button
          type="button"
          className={cn(PILL, 'tabular-nums text-fg hover:bg-surface-2')}
          onClick={() => onOpenChanges?.()}
          aria-label={
            status.added > 0 || status.removed > 0
              ? `Open Changes panel, ${status.fileCount} files, +${status.added} -${status.removed} lines`
              : `Open Changes panel, ${status.fileCount} files`
          }
          title={
            status.added > 0 || status.removed > 0
              ? `${status.fileCount} files · +${status.added} / -${status.removed} lines`
              : `${status.fileCount} files changed`
          }
        >
          <span>Changes</span>
          {status.added > 0 ? <span className="text-success">+{status.added}</span> : null}
          {status.removed > 0 ? <span className="text-danger">-{status.removed}</span> : null}
          {status.added > 0 || status.removed > 0 ? (
            <span className="text-muted">lines</span>
          ) : null}
          <Icon name="chevronRight" size={14} className="-rotate-90" />
        </button>
        {status.truncated ? (
          <span className="px-1 text-[11px] text-muted" title="File list is truncated">
            Showing first {status.files.length} of {status.fileCount}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** Branch label + refresh — sits on the Changes leading row. */
export function GitBranchStrip({ chrome }: { chrome: GitChrome }) {
  const { status, ready, refresh } = chrome
  if (!ready || !status) return null

  const branchLabel =
    status.branch && status.branch !== 'HEAD' ? status.branch : 'detached'

  return (
    <div className="pointer-events-auto flex shrink-0 items-center gap-2 px-1 text-[11px] text-tertiary">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Icon name="branch" size={14} />
        <span className="max-w-[24ch] truncate text-fg" title={branchLabel}>
          {branchLabel}
        </span>
      </span>

      <button
        type="button"
        className="inline-grid size-6 place-items-center rounded-sm vy-transition hover:bg-surface hover:text-fg"
        onClick={refresh}
        aria-label="Refresh git status"
      >
        <Icon name="refresh" size={14} />
      </button>
    </div>
  )
}

export { defaultCommitMessageFromStatus }
