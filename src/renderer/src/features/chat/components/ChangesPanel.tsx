import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn, Switch, Tooltip } from '@renderer/lib/ui'
import { matchShortcut, shortcutLabel } from '@renderer/lib/shortcuts'
import { Icon, type IconName } from '@renderer/lib/icons'
import { CHAT_RIGHT_PANEL_BODY } from '@renderer/lib/utils/layout'
import type { GitBranchEntry, GitChangedFile, GitLogEntry, GitStatus } from '@shared/ipc'
import type { UiItem } from '@shared/transcript'
import { ChangeSummary } from './ChangeSummary'
import {
  DOCK_TOOLBAR_BTN,
  DOCK_TOOLBAR_ICON_BTN,
  DockSplitButton,
  EmptyPanel
} from './PanelChrome'
import { type DiffLayout } from './DiffPreview'
import {
  ChangedFilesBrowser,
  type BrowserFileEntry
} from './ChangedFilesBrowser'
import { useGitChrome, type GitChrome } from './GitChrome'
import { CommitComposer, defaultCommitMessage } from './CommitComposer'
import {
  collectLastTurnChangedFiles,
  collectLastTurnFileDiffs,
  collectSessionChangedFiles,
  collectSessionFileDiffs
} from '../utils/turnFileDiffs'

type ChangeScope = 'agent' | 'uncommitted' | 'staged' | 'unstaged' | 'commits'

const SCOPE_LABEL: Record<ChangeScope, string> = {
  agent: 'Last Agent Turn',
  uncommitted: 'Uncommitted',
  staged: 'Staged',
  unstaged: 'Unstaged',
  commits: 'Commits'
}

function sideDelta(
  file: GitChangedFile,
  scope: ChangeScope
): { added: number; removed: number } {
  if (scope === 'staged') {
    return { added: file.addedStaged, removed: file.removedStaged }
  }
  if (scope === 'unstaged') {
    return { added: file.addedUnstaged, removed: file.removedUnstaged }
  }
  return { added: file.added, removed: file.removed }
}

function statusBadge(status: GitChangedFile['status']): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'New'
    case 'deleted':
      return 'Deleted'
    case 'modified':
      return 'Modified'
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

function statusLetter(status: GitChangedFile['status']): BrowserFileEntry['statusLetter'] {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'A'
    case 'deleted':
      return 'D'
    case 'modified':
      return 'M'
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

function toBrowserEntry(file: GitChangedFile, scope: ChangeScope): BrowserFileEntry {
  const delta = sideDelta(file, scope === 'commits' ? 'uncommitted' : scope)
  const label = statusBadge(file.status)
  return {
    path: file.path,
    statusLetter: statusLetter(file.status),
    statusLabel: label,
    statusTone:
      file.status === 'added' || file.status === 'untracked' ? 'success' : 'muted',
    added: delta.added,
    removed: delta.removed,
    binary: file.binary,
    staged: file.staged,
    unstaged: file.unstaged
  }
}

function ScopeDelta({ added, removed }: { added: number; removed: number }) {
  if (added <= 0 && removed <= 0) return null
  return (
    <span className="ml-1 tabular-nums">
      {added > 0 ? <span className="text-success">+{added}</span> : null}
      {removed > 0 ? (
        <span className={cn(added > 0 && 'ml-1', 'text-danger')}>-{removed}</span>
      ) : null}
    </span>
  )
}

const SCOPE_ICON: Record<ChangeScope, IconName> = {
  agent: 'bot',
  uncommitted: 'doc',
  staged: 'plus',
  unstaged: 'circle',
  commits: 'branch'
}

/**
 * Docked Changes panel: git working tree + agent Keep/Discard rollup.
 */
export function ChangesPanel({
  items,
  className,
  workspacePath,
  gitRevision = 0,
  chrome: chromeProp,
  onGitMutated,
  onViewPr,
  writeFileResolutions,
  resolvablePaths,
  canResolve,
  resolveBusy,
  resolveBlockedReason,
  onKeepWriteFile,
  onDiscardWriteFile,
  onKeepAllWrites,
  onDiscardAllWrites,
  active = true,
  preferredScope = 'uncommitted',
  preferredScopeToken = 0
}: {
  items: UiItem[]
  className?: string
  workspacePath?: string | null
  gitRevision?: number
  /** Shared chrome from ChatView — avoids a second gitStatus fetch when the dock is open. */
  chrome?: GitChrome
  /** Notify parent (composer git chrome) after commits / refreshes from this panel. */
  onGitMutated?: () => void
  onViewPr?: () => void
  writeFileResolutions?: ReadonlyMap<string, 'kept' | 'discarded' | undefined>
  resolvablePaths?: ReadonlySet<string>
  canResolve?: boolean
  resolveBusy?: boolean
  resolveBlockedReason?: string | null
  onKeepWriteFile?: (path: string) => void | Promise<unknown>
  onDiscardWriteFile?: (path: string) => void | Promise<unknown>
  onKeepAllWrites?: () => void | Promise<unknown>
  onDiscardAllWrites?: () => void | Promise<unknown>
  /** When false (hidden mounted dock), do not intercept Ctrl/Cmd+F/R. */
  active?: boolean
  /** Scope requested by the parent (e.g. transcript Open Changes → agent). */
  preferredScope?: ChangeScope
  /** Bump to re-apply preferredScope even if the scope value is unchanged. */
  preferredScopeToken?: number
}) {
  // Prefer parent-shared chrome; fall back for tests that mount the panel alone.
  const localChrome = useGitChrome(
    chromeProp ? null : (workspacePath ?? null),
    gitRevision,
    !chromeProp && Boolean(workspacePath) && active,
    0
  )
  const chrome = chromeProp ?? localChrome
  // Agent scope = last user turn only (matches “Last Agent Turn” label).
  const agentFiles = useMemo(() => collectLastTurnChangedFiles(items), [items])
  const agentDiffs = useMemo(() => collectLastTurnFileDiffs(items), [items])
  // Session-wide rollup under git scopes.
  const sessionAgentFiles = useMemo(() => collectSessionChangedFiles(items), [items])
  const sessionAgentDiffs = useMemo(() => collectSessionFileDiffs(items), [items])

  const [scope, setScope] = useState<ChangeScope>(preferredScope)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [layout, setLayout] = useState<DiffLayout>('unified')
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [composePrefersPush, setComposePrefersPush] = useState(true)
  const [message, setMessage] = useState('')
  const [pushOpen, setPushOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branches, setBranches] = useState<GitBranchEntry[]>([])
  const [branchesBusy, setBranchesBusy] = useState(false)
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [selectedCommit, setSelectedCommit] = useState<GitLogEntry | null>(null)
  const [commitFiles, setCommitFiles] = useState<GitChangedFile[]>([])
  const [commitsBusy, setCommitsBusy] = useState(false)
  const toolbarMenusRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const commitsSeqRef = useRef(0)
  const branchesSeqRef = useRef(0)

  const closeMenus = useCallback(() => {
    setScopeOpen(false)
    setMenuOpen(false)
    setLayoutOpen(false)
    setPushOpen(false)
    setBranchOpen(false)
  }, [])

  useEffect(() => {
    setScope('uncommitted')
    setSelectedCommit(null)
    setCommitFiles([])
    setCommits([])
    setExpanded(new Set())
    setSelectedPath(null)
    setComposing(false)
    setMessage('')
    setFindOpen(false)
    setFindQuery('')
    closeMenus()
  }, [workspacePath, closeMenus])

  useEffect(() => {
    if (preferredScopeToken <= 0) return
    setScope(preferredScope)
    if (preferredScope !== 'commits') setSelectedCommit(null)
    setExpanded(new Set())
    setSelectedPath(null)
  }, [preferredScope, preferredScopeToken])

  // Non-git workspaces with agent edits: prefer agent scope so we never stack
  // "Not a git repository" with an Agent edits footer.
  const displayScope: ChangeScope =
    chrome.result?.kind === 'not_repo' &&
    sessionAgentFiles.length > 0 &&
    scope !== 'agent' &&
    scope !== 'commits'
      ? 'agent'
      : scope

  useEffect(() => {
    if (displayScope === scope) return
    setScope(displayScope)
  }, [displayScope, scope])

  useEffect(() => {
    if (!scopeOpen && !menuOpen && !pushOpen && !branchOpen) return undefined
    const onPointerDown = (e: PointerEvent): void => {
      if (toolbarMenusRef.current && !toolbarMenusRef.current.contains(e.target as Node)) {
        closeMenus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [scopeOpen, menuOpen, pushOpen, branchOpen, closeMenus])

  const refreshCommits = useCallback(async () => {
    const seq = ++commitsSeqRef.current
    if (!workspacePath || !window.vyotiq?.gitLog) {
      if (seq === commitsSeqRef.current) setCommits([])
      return
    }
    setCommitsBusy(true)
    try {
      const res = await window.vyotiq.gitLog({ workspacePath, limit: 40 })
      if (seq !== commitsSeqRef.current) return
      if (!res.ok) {
        setCommits([])
        return
      }
      setCommits(res.data)
    } finally {
      if (seq === commitsSeqRef.current) setCommitsBusy(false)
    }
  }, [workspacePath])

  const refreshBranches = useCallback(async () => {
    if (!workspacePath || !window.vyotiq?.gitBranches) {
      setBranches([])
      return
    }
    const seq = ++branchesSeqRef.current
    setBranchesBusy(true)
    try {
      const res = await window.vyotiq.gitBranches(workspacePath)
      if (seq !== branchesSeqRef.current) return
      if (!res.ok) {
        setBranches([])
        return
      }
      setBranches(res.data)
    } finally {
      if (seq === branchesSeqRef.current) setBranchesBusy(false)
    }
  }, [workspacePath])

  useEffect(() => {
    if (!active) return
    void refreshCommits()
  }, [active, refreshCommits, gitRevision])

  useEffect(() => {
    if (scope !== 'commits' || !selectedCommit || !workspacePath) {
      setCommitFiles([])
      return
    }
    let cancelled = false
    void window.vyotiq?.gitCommitFiles?.({ workspacePath, sha: selectedCommit.sha }).then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setCommitFiles([])
        return
      }
      setCommitFiles(res.data.files)
    })
    return () => {
      cancelled = true
    }
  }, [scope, selectedCommit, workspacePath])

  useEffect(() => {
    if (!findOpen) return
    findInputRef.current?.focus()
    findInputRef.current?.select()
  }, [findOpen])

  useEffect(() => {
    if (!active) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (matchShortcut(e, 'find')) {
        e.preventDefault()
        setFindOpen(true)
        return
      }
      if (matchShortcut(e, 'refresh')) {
        e.preventDefault()
        chrome.refresh()
        void refreshCommits()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, chrome, refreshCommits])

  const status: GitStatus | null = chrome.status
  const gitFiles = useMemo(() => status?.files ?? [], [status?.files])

  const scopeTotals = useMemo(() => {
    const sumSide = (files: GitChangedFile[], side: 'all' | 'staged' | 'unstaged') => {
      let added = 0
      let removed = 0
      for (const f of files) {
        if (side === 'staged') {
          added += f.addedStaged
          removed += f.removedStaged
        } else if (side === 'unstaged') {
          added += f.addedUnstaged
          removed += f.removedUnstaged
        } else {
          added += f.added
          removed += f.removed
        }
      }
      return { added, removed }
    }
    return {
      agent: {
        added: agentFiles.reduce((s, f) => s + f.added, 0),
        removed: agentFiles.reduce((s, f) => s + f.removed, 0)
      },
      uncommitted: sumSide(gitFiles, 'all'),
      staged: sumSide(gitFiles.filter((f) => f.staged), 'staged'),
      unstaged: sumSide(gitFiles.filter((f) => f.unstaged), 'unstaged'),
      commits: { added: 0, removed: 0 }
    }
  }, [agentFiles, gitFiles])

  const visibleGitFiles = useMemo(() => {
    switch (displayScope) {
      case 'agent':
        return []
      case 'commits':
        return commitFiles
      case 'staged':
        return gitFiles.filter((f) => f.staged)
      case 'unstaged':
        return gitFiles.filter((f) => f.unstaged)
      case 'uncommitted':
        return gitFiles
      default: {
        const _exhaustive: never = displayScope
        return _exhaustive
      }
    }
  }, [gitFiles, displayScope, commitFiles])

  const filteredFiles = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    if (!q) return visibleGitFiles
    return visibleGitFiles.filter((f) => f.path.toLowerCase().includes(q))
  }, [visibleGitFiles, findQuery])

  const browserFiles = useMemo(
    () => filteredFiles.map((f) => toBrowserEntry(f, displayScope)),
    [filteredFiles, displayScope]
  )

  const totals = useMemo(() => {
    if (displayScope === 'agent') {
      return {
        files: agentFiles.length,
        added: agentFiles.reduce((s, f) => s + f.added, 0),
        removed: agentFiles.reduce((s, f) => s + f.removed, 0)
      }
    }
    if (displayScope === 'staged' || displayScope === 'unstaged' || displayScope === 'uncommitted') {
      let added = 0
      let removed = 0
      for (const f of filteredFiles) {
        const d = sideDelta(f, displayScope)
        added += d.added
        removed += d.removed
      }
      return { files: filteredFiles.length, added, removed }
    }
    return {
      files: filteredFiles.length,
      added: filteredFiles.reduce((s, f) => s + f.added, 0),
      removed: filteredFiles.reduce((s, f) => s + f.removed, 0)
    }
  }, [displayScope, agentFiles, filteredFiles])

  const togglePath = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    // Cap so Expand All cannot mount 100+ diff shells at once.
    const EXPAND_ALL_MAX = 12
    setExpanded(new Set(filteredFiles.slice(0, EXPAND_ALL_MAX).map((f) => f.path)))
    closeMenus()
  }, [filteredFiles, closeMenus])

  const commitMode: 'all' | 'staged' = scope === 'staged' ? 'staged' : 'all'

  const sendCommit = useCallback(
    (push: boolean) => {
      void chrome.commit(message, push, commitMode).then((ok) => {
        if (!ok) return
        setMessage('')
        setComposing(false)
        setPushOpen(false)
        onGitMutated?.()
        void refreshCommits()
      })
    },
    [chrome, message, commitMode, onGitMutated, refreshCommits]
  )

  const sendStageAll = useCallback(() => {
    void chrome.stageAll().then((ok) => {
      if (!ok) return
      onGitMutated?.()
    })
  }, [chrome, onGitMutated])

  const openCompose = useCallback(
    (prefersPush: boolean) => {
      setComposePrefersPush(prefersPush)
      setMessage(defaultCommitMessage(filteredFiles, filteredFiles.length))
      setComposing(true)
      setPushOpen(false)
    },
    [filteredFiles]
  )

  const checkoutBranch = useCallback(
    async (branch: string) => {
      if (!workspacePath || !window.vyotiq?.gitCheckout) return
      if (status && status.fileCount > 0) {
        const confirmed = window.confirm(
          `Working tree has uncommitted changes. Check out "${branch}" anyway?`
        )
        if (!confirmed) return
      }
      closeMenus()
      const res = await window.vyotiq.gitCheckout(workspacePath, branch)
      if (res.ok) {
        chrome.refresh()
        onGitMutated?.()
        void refreshCommits()
      }
    },
    [workspacePath, status, closeMenus, chrome, onGitMutated, refreshCommits]
  )

  const fileDiffStaged = useCallback(
    (file: GitChangedFile): boolean => {
      if (scope === 'staged') return true
      if (scope === 'unstaged') return false
      if (scope === 'uncommitted') return file.unstaged ? false : Boolean(file.staged)
      return false
    },
    [scope]
  )

  const filteredFilesRef = useRef(filteredFiles)
  filteredFilesRef.current = filteredFiles
  const fileDiffStagedRef = useRef(fileDiffStaged)
  fileDiffStagedRef.current = fileDiffStaged

  const empty =
    displayScope === 'agent'
      ? agentFiles.length === 0
      : displayScope === 'commits' && !selectedCommit
        ? commits.length === 0 && !commitsBusy
        : filteredFiles.length === 0 && !chrome.busy

  const emptyTitle = !workspacePath
    ? 'No workspace'
    : chrome.error
      ? 'Git status unavailable'
      : chrome.result?.kind === 'unavailable'
        ? 'Git not found'
        : displayScope === 'agent'
          ? 'No agent edits'
          : chrome.result?.kind === 'not_repo'
            ? 'Not a git repository'
            : 'No changes yet'

  const emptyBody = !workspacePath
    ? 'Open a workspace to view git changes and resolve agent edits.'
    : chrome.error
      ? chrome.error
      : chrome.result?.kind === 'unavailable'
        ? chrome.result.detail
        : displayScope === 'agent'
          ? 'Agent edits will appear here with Keep / Discard when available.'
          : chrome.result?.kind === 'not_repo'
            ? 'This workspace has no .git directory. Git working-tree changes cannot be listed.'
            : displayScope === 'commits'
              ? 'No commits found in this repository.'
              : 'Working tree changes will appear here when files differ from HEAD.'

  const showGitEmpty =
    empty &&
    (displayScope === 'agent' ||
      displayScope === 'commits' ||
      !workspacePath ||
      chrome.error != null ||
      chrome.result?.kind === 'unavailable' ||
      chrome.result?.kind === 'not_repo' ||
      chrome.result?.kind === 'ok')

  const commitPrimaryPushes = Boolean(status?.hasRemote)
  const commitSha = displayScope === 'commits' ? selectedCommit?.sha ?? null : null

  const stageActions =
    displayScope === 'commits' || displayScope === 'agent'
      ? undefined
      : {
          busy: chrome.busy,
          onStage: (path: string) => {
            void chrome.stagePaths([path]).then((ok) => {
              if (ok) onGitMutated?.()
            })
          },
          onUnstage: (path: string) => {
            void chrome.unstagePaths([path]).then((ok) => {
              if (ok) onGitMutated?.()
            })
          },
          canStage: (file: BrowserFileEntry) => Boolean(file.unstaged),
          canUnstage: (file: BrowserFileEntry) => Boolean(file.staged)
        }

  const fetchGitDiff = useCallback(
    async (path: string) => {
      if (!workspacePath) return { error: 'No workspace' }
      const file = filteredFilesRef.current.find((f) => f.path === path)
      const staged = file ? fileDiffStagedRef.current(file) : false
      const res = await window.vyotiq.gitDiff({
        workspacePath,
        path,
        staged: commitSha ? undefined : staged,
        ignoreWhitespace,
        sha: commitSha ?? undefined
      })
      if (!res.ok) return { error: res.error }
      return { content: res.data.content }
    },
    [workspacePath, ignoreWhitespace, commitSha]
  )

  return (
    <div
      className={cn(CHAT_RIGHT_PANEL_BODY, className)}
      data-changes-panel
      role="region"
      aria-label="Changes"
    >
      <div
        ref={toolbarMenusRef}
        className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/40 px-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <div className="relative shrink-0">
          <button
            type="button"
            className="inline-flex h-6 max-w-[9rem] items-center gap-1 rounded-md px-1.5 text-[11px] leading-none text-fg hover:bg-surface-2"
            onClick={() => {
              const next = !scopeOpen
              closeMenus()
              setScopeOpen(next)
            }}
            aria-expanded={scopeOpen}
          >
            <Icon name="branch" size={12} className="shrink-0 text-muted" />
            <span className="truncate">
              {displayScope === 'commits' && selectedCommit
                ? selectedCommit.shortSha
                : displayScope === 'commits'
                  ? 'All Commits'
                  : SCOPE_LABEL[displayScope]}
            </span>
            <Icon name="chevron" size={10} className="shrink-0 text-muted" />
          </button>
          {scopeOpen ? (
            <div className="absolute left-0 top-full z-dropdown mt-0.5 min-w-[13rem] rounded-md border border-border bg-bg py-1 shadow-lg">
              {(Object.keys(SCOPE_LABEL) as ChangeScope[]).map((key) => {
                const totalsForScope = scopeTotals[key]
                return (
                  <button
                    key={key}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-surface',
                      displayScope === key ? 'text-fg' : 'text-muted'
                    )}
                    onClick={() => {
                      setScope(key)
                      if (key !== 'commits') setSelectedCommit(null)
                      setExpanded(new Set())
                      setSelectedPath(null)
                      closeMenus()
                    }}
                  >
                    <Icon name={SCOPE_ICON[key]} size={12} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">
                      {SCOPE_LABEL[key]}
                      <ScopeDelta
                        added={totalsForScope.added}
                        removed={totalsForScope.removed}
                      />
                    </span>
                    {displayScope === key ? <Icon name="check" size={12} className="shrink-0" /> : null}
                    {key === 'commits' ? (
                      <Icon name="chevronRight" size={10} className="shrink-0 text-muted" />
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>

        <span className="shrink-0 tabular-nums text-[11px] leading-none text-muted">
          {totals.added > 0 ? <span className="text-success">+{totals.added}</span> : null}
          {totals.removed > 0 ? (
            <span className="ml-1 text-danger">-{totals.removed}</span>
          ) : null}
        </span>

        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            className="inline-flex h-6 w-full min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 text-[11px] leading-none text-muted hover:bg-surface-2 hover:text-fg"
            disabled={!workspacePath || chrome.result?.kind !== 'ok'}
            onClick={() => {
              const next = !branchOpen
              closeMenus()
              setBranchOpen(next)
              if (next) void refreshBranches()
            }}
            aria-expanded={branchOpen}
            title={status?.branch ?? 'Switch branch'}
          >
            <Icon name="branch" size={12} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{status?.branch ?? 'branch'}</span>
            <Icon name="chevron" size={10} className="shrink-0" />
          </button>
          {branchOpen ? (
            <div className="absolute left-0 top-full z-dropdown mt-0.5 max-h-56 min-w-[12rem] overflow-auto rounded-md border border-border bg-bg py-1 shadow-lg">
              {branchesBusy ? (
                <p className="m-0 px-2.5 py-1.5 text-[11px] text-muted">Loading…</p>
              ) : branches.length === 0 ? (
                <p className="m-0 px-2.5 py-1.5 text-[11px] text-muted">No local branches</p>
              ) : (
                branches.map((b) => (
                  <button
                    key={b.name}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-surface',
                      b.current ? 'text-fg' : 'text-muted'
                    )}
                    disabled={b.current}
                    onClick={() => void checkoutBranch(b.name)}
                  >
                    <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    {b.current ? <Icon name="check" size={12} className="shrink-0" /> : null}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <div className="relative">
            <Tooltip content="More changes actions">
              <button
                type="button"
                className={DOCK_TOOLBAR_ICON_BTN}
                aria-label="More changes actions"
                onClick={() => {
                  const next = !menuOpen
                  closeMenus()
                  setMenuOpen(next)
                }}
              >
                ···
              </button>
            </Tooltip>
            {menuOpen ? (
              <div className="absolute right-0 top-full z-dropdown mt-0.5 min-w-[14rem] rounded-md border border-border bg-bg py-1 shadow-lg">
                <div className="relative">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-surface"
                    onClick={() => setLayoutOpen((v) => !v)}
                    aria-expanded={layoutOpen}
                  >
                    <span>
                      Layout{' '}
                      <span className="text-muted">
                        {layout === 'unified' ? 'Unified' : 'Split'}
                      </span>
                    </span>
                    <Icon name="chevronRight" size={10} className="text-muted" />
                  </button>
                  {layoutOpen ? (
                    <div className="absolute left-full top-0 z-dropdown ml-0.5 min-w-[7rem] rounded-md border border-border bg-bg py-1 shadow-lg">
                      {(['unified', 'split'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={cn(
                            'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] capitalize hover:bg-surface',
                            layout === mode ? 'text-fg' : 'text-muted'
                          )}
                          onClick={() => {
                            setLayout(mode)
                            setLayoutOpen(false)
                            closeMenus()
                          }}
                        >
                          {mode}
                          {layout === mode ? <Icon name="check" size={12} className="ml-auto" /> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <label className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-fg">
                  Ignore Whitespace
                  <Switch
                    checked={ignoreWhitespace}
                    onCheckedChange={setIgnoreWhitespace}
                    label="Ignore Whitespace"
                  />
                </label>
                <label className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-fg">
                  Word Wrap
                  <Switch
                    checked={wordWrap}
                    onCheckedChange={setWordWrap}
                    label="Word Wrap"
                  />
                </label>
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[11px] hover:bg-surface"
                  onClick={() => {
                    setFindOpen(true)
                    closeMenus()
                  }}
                >
                  Find in Changes
                  <span className="text-[10px] text-muted">{shortcutLabel('find')}</span>
                </button>
                <button
                  type="button"
                  className="flex w-full px-2.5 py-1.5 text-left text-[11px] hover:bg-surface"
                  onClick={expandAll}
                >
                  Expand All
                </button>
                <button
                  type="button"
                  className="flex w-full px-2.5 py-1.5 text-left text-[11px] hover:bg-surface"
                  onClick={() => {
                    setExpanded(new Set())
                    closeMenus()
                  }}
                >
                  Collapse All
                </button>
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[11px] hover:bg-surface"
                  onClick={() => {
                    chrome.refresh()
                    void refreshCommits()
                    closeMenus()
                  }}
                >
                  Refresh Changes
                  <span className="text-[10px] text-muted">{shortcutLabel('refresh')}</span>
                </button>
              </div>
            ) : null}
          </div>

          {onViewPr ? (
            <button type="button" className={DOCK_TOOLBAR_BTN} onClick={onViewPr}>
              <Icon name="pullRequest" size={12} className="shrink-0" />
              View PR
            </button>
          ) : null}

          {displayScope === 'unstaged' && status && filteredFiles.length > 0 ? (
            <button
              type="button"
              className={DOCK_TOOLBAR_BTN}
              disabled={chrome.busy}
              onClick={sendStageAll}
            >
              Stage All
            </button>
          ) : null}

          {(displayScope === 'uncommitted' || displayScope === 'staged') &&
          status &&
          filteredFiles.length > 0 ? (
            composing ? (
              <CommitComposer
                compact
                className="mr-1"
                inputClassName="mr-1 h-6 w-36 rounded-md border border-border bg-bg px-1.5 text-[11px] leading-none text-fg outline-none"
                message={message}
                onMessageChange={setMessage}
                busy={chrome.busy}
                hasRemote={Boolean(status.hasRemote)}
                primaryPushes={composePrefersPush && commitPrimaryPushes}
                onCommit={sendCommit}
                onCancel={() => setComposing(false)}
              />
            ) : status.hasRemote ? (
              <DockSplitButton
                primaryLabel={commitPrimaryPushes ? 'Commit & Push' : 'Commit'}
                primaryDisabled={chrome.busy}
                onPrimaryClick={() => openCompose(commitPrimaryPushes)}
                menuOpen={pushOpen}
                onMenuToggle={() => setPushOpen((v) => !v)}
                menuAriaLabel="More commit options"
                menu={
                  pushOpen ? (
                    <div className="absolute right-0 top-full z-dropdown mt-0.5 min-w-[9rem] rounded-md border border-border bg-bg py-1 shadow-lg">
                      <button
                        type="button"
                        className="flex w-full whitespace-nowrap px-2.5 py-1.5 text-left text-[11px] hover:bg-surface"
                        onClick={() => openCompose(!commitPrimaryPushes)}
                      >
                        {commitPrimaryPushes ? 'Commit' : 'Commit & Push'}
                      </button>
                    </div>
                  ) : null
                }
              />
            ) : (
              <button
                type="button"
                className={DOCK_TOOLBAR_BTN}
                disabled={chrome.busy}
                onClick={() => openCompose(false)}
              >
                Commit
              </button>
            )
          ) : null}
        </div>
      </div>

      {findOpen ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-2 py-1">
          <Icon name="search" size={12} className="shrink-0 text-muted" />
          <input
            ref={findInputRef}
            type="search"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            placeholder="Find in changes"
            aria-label="Find in changes"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-fg outline-none placeholder:text-muted"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setFindOpen(false)
                setFindQuery('')
              }
            }}
          />
          <button
            type="button"
            className="rounded px-1 text-[10px] text-muted hover:text-fg"
            aria-label="Close find"
            onClick={() => {
              setFindOpen(false)
              setFindQuery('')
            }}
          >
            Esc
          </button>
        </div>
      ) : null}

      {chrome.notice ? (
        <p
          className={cn(
            'm-0 shrink-0 border-b border-border/40 px-3 py-1 text-[11px]',
            chrome.noticeFailed ? 'text-danger' : 'text-secondary'
          )}
          role={chrome.noticeFailed ? 'alert' : 'status'}
        >
          {chrome.notice}
        </p>
      ) : null}

      {status?.truncated && displayScope !== 'agent' && displayScope !== 'commits' ? (
        <p className="m-0 shrink-0 border-b border-border/40 px-3 py-1 text-[11px] text-muted">
          Showing first {status.files.length} of {status.fileCount} changed files
        </p>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2">
        {!workspacePath ? (
          <EmptyPanel icon="branch" title={emptyTitle} body={emptyBody} />
        ) : displayScope !== 'agent' && displayScope !== 'commits' && chrome.loading && !chrome.ready ? (
          <EmptyPanel
            icon="branch"
            title="Loading changes…"
            body="Reading git status for this workspace."
          />
        ) : showGitEmpty ? (
          <EmptyPanel icon="branch" title={emptyTitle} body={emptyBody} />
        ) : displayScope === 'agent' ? (
          <div className="min-h-0 flex-1 overflow-auto" data-diff-scroll-root>
            <ChangeSummary
              files={agentFiles}
              fileDiffs={agentDiffs}
              fileResolutions={writeFileResolutions}
              resolvablePaths={resolvablePaths}
              canResolve={canResolve}
              resolveBusy={resolveBusy}
              resolveBlockedReason={resolveBlockedReason}
              onKeepFile={onKeepWriteFile}
              onDiscardFile={onDiscardWriteFile}
              onKeepAll={onKeepAllWrites}
              onDiscardAll={onDiscardAllWrites}
            />
          </div>
        ) : displayScope === 'commits' && !selectedCommit ? (
          <ul className="m-0 min-h-0 flex-1 list-none overflow-auto rounded-md border border-border/50 bg-surface p-0">
            <li className="border-b border-border/40 px-3 py-1.5 text-[11px] text-fg">
              {commits.length} {commits.length === 1 ? 'Commit' : 'Commits'}
            </li>
            {commits.map((c) => (
              <li key={c.sha} className="border-b border-border/40 last:border-b-0">
                <button
                  type="button"
                  className="flex w-full min-w-0 flex-col gap-0.5 px-3 py-1.5 text-left text-[11px] hover:bg-surface/60"
                  onClick={() => {
                    setSelectedCommit(c)
                    setExpanded(new Set())
                    setSelectedPath(null)
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-muted">{c.shortSha}</span>
                    <span className="min-w-0 truncate text-fg">{c.subject}</span>
                  </span>
                  <span className="text-[10px] text-muted">
                    {c.author} · {c.relativeDate}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto" data-diff-scroll-root>
            {displayScope === 'commits' && selectedCommit ? (
              <div className="flex shrink-0 items-center gap-2 rounded-md border border-border/50 bg-surface px-3 py-1.5 text-[11px]">
                <button
                  type="button"
                  className="shrink-0 text-muted hover:text-fg"
                  onClick={() => {
                    setSelectedCommit(null)
                    setExpanded(new Set())
                    setSelectedPath(null)
                  }}
                >
                  ← Commits
                </button>
                <span className="min-w-0 truncate font-mono text-muted">
                  {selectedCommit.shortSha}
                </span>
                <span className="min-w-0 flex-1 truncate text-fg">{selectedCommit.subject}</span>
              </div>
            ) : null}
            <ChangedFilesBrowser
              ownScroll={false}
              files={browserFiles}
              totals={{ added: totals.added, removed: totals.removed }}
              expanded={expanded}
              onToggleExpand={togglePath}
              selectedPath={selectedPath}
              onSelectPath={setSelectedPath}
              fetchDiff={fetchGitDiff}
              layout={layout}
              wordWrap={wordWrap}
              findQuery={findQuery}
              stageActions={stageActions}
            />
            {workspacePath &&
            chrome.result?.kind !== 'not_repo' &&
            sessionAgentFiles.length > 0 ? (
              <div className="shrink-0">
                <p className="m-0 mb-1.5 px-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                  Agent edits
                </p>
                <ChangeSummary
                  files={sessionAgentFiles}
                  fileDiffs={sessionAgentDiffs}
                  fileResolutions={writeFileResolutions}
                  resolvablePaths={resolvablePaths}
                  canResolve={canResolve}
                  resolveBusy={resolveBusy}
                  resolveBlockedReason={resolveBlockedReason}
                  onKeepFile={onKeepWriteFile}
                  onDiscardFile={onDiscardWriteFile}
                  onKeepAll={onKeepAllWrites}
                  onDiscardAll={onDiscardAllWrites}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
