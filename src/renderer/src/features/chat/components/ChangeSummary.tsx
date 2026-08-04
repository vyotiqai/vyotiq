import { memo, useMemo, useState } from 'react'
import { Button, Tooltip, cn } from '@renderer/lib/ui'
import { TOOL_CARD_HEADER, TOOL_CARD_SURFACE } from '@renderer/lib/utils/layout'
import type { ChangedFile } from '../utils/transcriptRows'
import { basename } from '../toolUi'
import type { DiffLine } from '../toolUi'
import { normalizeRelPath } from '../utils/turnFileDiffs'
import { FileBadge } from './FileBadge'
import { DiffPreview } from './DiffPreview'

export type ChangeSummaryFileResolution = 'kept' | 'discarded' | undefined

/** Transcript compact receipt: first N rows, then “… Show N more”. */
export const COMPACT_PREVIEW_COUNT = 4

export const ChangeSummary = memo(function ChangeSummary({
  files,
  fileDiffs,
  fileResolutions,
  resolvablePaths,
  canResolve = false,
  resolveBusy = false,
  resolveBlockedReason = null,
  onKeepFile,
  onDiscardFile,
  onKeepAll,
  onDiscardAll,
  onDiffExpandChange,
  compact = false,
  onOpenChanges
}: {
  files: ChangedFile[]
  /** Path → tool-arg diff lines for this turn (optional). */
  fileDiffs?: ReadonlyMap<string, DiffLine[]>
  /** Path → Keep/Discard status from the write checkpoint. */
  fileResolutions?: ReadonlyMap<string, ChangeSummaryFileResolution>
  /**
   * Paths that belong to the active write checkpoint. Keep/Discard only apply
   * here — session-wide older edits stay list-only.
   */
  resolvablePaths?: ReadonlySet<string>
  canResolve?: boolean
  resolveBusy?: boolean
  /** When set, Keep/Discard stay visible but disabled (e.g. mid-run). */
  resolveBlockedReason?: string | null
  onKeepFile?: (path: string) => void | Promise<unknown>
  onDiscardFile?: (path: string) => void | Promise<unknown>
  onKeepAll?: () => void | Promise<unknown>
  onDiscardAll?: () => void | Promise<unknown>
  /** Fired when any file diff panel is open (for virtualizer estimates). */
  onDiffExpandChange?: (hasExpanded: boolean) => void
  /** Transcript receipt — no Keep/Discard; Review opens Changes. */
  compact?: boolean
  onOpenChanges?: () => void
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [showAll, setShowAll] = useState(false)

  const normalizedResolvablePaths = useMemo(() => {
    if (!resolvablePaths) return null
    return new Set(Array.from(resolvablePaths).map((p) => normalizeRelPath(p)))
  }, [resolvablePaths])

  if (files.length === 0) return null

  const resolveDisabled = Boolean(resolveBusy || resolveBlockedReason)

  const isResolvablePath = (path: string): boolean => {
    if (!resolvablePaths || !normalizedResolvablePaths) return true
    return resolvablePaths.has(path) || normalizedResolvablePaths.has(normalizeRelPath(path))
  }

  const totalAdded = files.reduce((sum, file) => sum + file.added, 0)
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0)
  const unresolved = files.filter((f) => {
    if (!isResolvablePath(f.path)) return false
    const norm = normalizeRelPath(f.path)
    return !(fileResolutions?.get(norm) ?? fileResolutions?.get(f.path))
  })

  const title = `${files.length} ${files.length === 1 ? 'File Changed' : 'Files Changed'}`
  /** Match ChangedFilesBrowser shell when embedded in the Changes panel. */
  const panelSurface =
    'w-full overflow-hidden rounded-md border border-border/50 bg-surface'
  const panelHeader =
    'flex shrink-0 items-center border-b border-border/40 px-3 py-1.5 text-[11px] text-fg'

  if (compact) {
    const visible = showAll ? files : files.slice(0, COMPACT_PREVIEW_COUNT)
    const hiddenCount = files.length - COMPACT_PREVIEW_COUNT
    const canToggleMore = hiddenCount > 0

    return (
      <div className={cn(TOOL_CARD_SURFACE, 'w-full')} data-change-summary="receipt">
        <div className={cn(TOOL_CARD_HEADER, 'flex items-center gap-2 border-b border-border text-fg')}>
          <span className="min-w-0 truncate font-medium">{title}</span>
          {onOpenChanges ? (
            <button
              type="button"
              className="ml-auto shrink-0 text-tertiary vy-transition hover:text-fg"
              onClick={() => onOpenChanges()}
              aria-label="Review changes"
            >
              Review
            </button>
          ) : null}
        </div>
        <ul className="m-0 list-none p-0">
          {visible.map((file) => (
            <li key={file.path} className="min-w-0 [&+&]:border-t [&+&]:border-border/60">
              <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs">
                <FileBadge path={file.path} />
                <span className="min-w-0 truncate text-fg" title={file.path}>
                  {basename(file.path)}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
                  {file.added > 0 ? <span className="text-success">+{file.added}</span> : null}
                  {file.removed > 0 ? <span className="text-danger">-{file.removed}</span> : null}
                </span>
              </div>
            </li>
          ))}
        </ul>
        {canToggleMore ? (
          <button
            type="button"
            className="flex w-full items-center border-t border-border/60 px-3 py-1.5 text-left text-xs text-tertiary vy-transition hover:bg-surface/40 hover:text-fg"
            onClick={() => setShowAll((prev) => !prev)}
            aria-expanded={showAll}
          >
            {showAll ? 'Show less' : `… Show ${hiddenCount} more`}
          </button>
        ) : null}
      </div>
    )
  }

  const togglePath = (path: string): void => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      onDiffExpandChange?.(next.size > 0)
      return next
    })
  }

  return (
    <div className={panelSurface} data-change-summary="panel">
      <div className={panelHeader}>
        <span className="font-medium">{title}</span>
        <span className="ml-auto flex items-center gap-2 tabular-nums text-tertiary">
          {totalAdded > 0 ? <span className="text-success">+{totalAdded}</span> : null}
          {totalRemoved > 0 ? <span className="ml-2 text-danger">-{totalRemoved}</span> : null}
          {canResolve && unresolved.length > 0 ? (
            <>
              {resolveBlockedReason ? (
                <span
                  className="ml-2 max-w-[12rem] truncate text-[10px] text-muted"
                  title={resolveBlockedReason}
                >
                  {resolveBlockedReason}
                </span>
              ) : null}
              {onKeepAll ? (
                <Button
                  variant="subtle"
                  className="ml-2 h-6 px-2 text-xs"
                  disabled={resolveDisabled}
                  title={resolveBlockedReason ?? undefined}
                  onClick={() => {
                    void onKeepAll()
                  }}
                >
                  {resolveBusy ? 'Working…' : 'Keep all'}
                </Button>
              ) : null}
              {onDiscardAll ? (
                <Button
                  variant="subtle"
                  className="h-6 px-2 text-xs"
                  disabled={resolveDisabled}
                  title={resolveBlockedReason ?? undefined}
                  onClick={() => {
                    void onDiscardAll()
                  }}
                >
                  {resolveBusy ? 'Working…' : 'Discard all'}
                </Button>
              ) : null}
            </>
          ) : null}
        </span>
      </div>
      <ul className="m-0 list-none p-0">
        {files.map((file) => {
          const norm = normalizeRelPath(file.path)
          const resolution = fileResolutions?.get(norm) ?? fileResolutions?.get(file.path)
          const lines = fileDiffs?.get(norm) ?? fileDiffs?.get(file.path)
          const expanded = expandedPaths.has(file.path)
          const canExpand = Boolean(lines && lines.length > 0) || file.removed > 0
          const showResolve = canResolve && isResolvablePath(file.path)

          return (
            <li key={file.path} className="min-w-0 [&+&]:border-t [&+&]:border-border/60">
              <div
                className={cn(
                  'sticky top-0 z-[1] flex min-w-0 items-center gap-2 bg-surface px-3 py-1.5 text-xs',
                  expanded && 'border-b border-border/40'
                )}
              >
                {canExpand ? (
                  <Tooltip content={expanded ? 'Hide diff' : 'Show diff'}>
                    <button
                      type="button"
                      className="shrink-0 rounded px-0.5 text-tertiary transition-colors hover:bg-surface-2 hover:text-fg"
                      aria-expanded={expanded}
                      aria-label={expanded ? 'Hide diff' : 'Show diff'}
                      onClick={() => togglePath(file.path)}
                    >
                      {expanded ? '▾' : '▸'}
                    </button>
                  </Tooltip>
                ) : (
                  <span className="w-3 shrink-0" aria-hidden />
                )}
                <FileBadge path={file.path} />
                <span className="min-w-0 truncate text-fg" title={file.path}>
                  {basename(file.path)}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
                  {file.added > 0 ? <span className="text-success">+{file.added}</span> : null}
                  {file.removed > 0 ? <span className="text-danger">-{file.removed}</span> : null}
                  {resolution === 'kept' ? (
                    <span className="text-tertiary">Kept</span>
                  ) : resolution === 'discarded' ? (
                    <span className="text-tertiary">Discarded</span>
                  ) : showResolve ? (
                    <>
                      {onKeepFile ? (
                        <Button
                          variant="subtle"
                          className="h-5 px-1.5 text-[10px]"
                          disabled={resolveDisabled}
                          title={resolveBlockedReason ?? undefined}
                          onClick={() => {
                            void onKeepFile(file.path)
                          }}
                        >
                          Keep
                        </Button>
                      ) : null}
                      {onDiscardFile ? (
                        <Button
                          variant="subtle"
                          className="h-5 px-1.5 text-[10px]"
                          disabled={resolveDisabled}
                          title={resolveBlockedReason ?? undefined}
                          onClick={() => {
                            void onDiscardFile(file.path)
                          }}
                        >
                          Discard
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </span>
              </div>
              {expanded ? (
                <div className="bg-surface-2/30 px-3 py-1">
                  {lines && lines.length > 0 ? (
                    <DiffPreview lines={lines} path={file.path} expanded />
                  ) : (
                    <p className="m-0 py-1 text-[11px] text-muted">File deleted</p>
                  )}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
})
