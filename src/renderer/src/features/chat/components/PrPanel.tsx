import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, cn, Switch, Tooltip } from '@renderer/lib/ui'
import { matchShortcut, shortcutLabel } from '@renderer/lib/shortcuts'
import { Icon, type IconName } from '@renderer/lib/icons'
import { MarkdownContent } from '@renderer/lib/ui/MarkdownContent'
import { CHAT_RIGHT_PANEL_BODY } from '@renderer/lib/utils/layout'
import type { GithubAuthStatus, PrFile, PrMergeMethod, PrReview, PrView } from '@shared/ipc'
import { DOCK_TOOLBAR_ICON_BTN, DockSplitButton, EmptyPanel } from './PanelChrome'
import { type DiffLayout } from './DiffPreview'
import {
  ChangedFilesBrowser,
  type BrowserFileEntry
} from './ChangedFilesBrowser'

type PrTab = 'changes' | 'description' | 'commits' | 'checks' | 'reviews'

function formatPrState(state: string): string {
  const lower = state.trim().toLowerCase()
  if (!lower) return state
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function prEmptyTitle(error: string | null): string {
  if (!error) return 'No pull request'
  if (/GitHub CLI \(gh\) is not installed|gh is not installed|not on PATH/i.test(error)) {
    return 'GitHub CLI not found'
  }
  if (/not a git repository/i.test(error)) return 'Not a git repository'
  if (/auth|login|HTTP 401|HTTP 403/i.test(error)) return 'GitHub authentication required'
  if (/no pull request|no open pull request/i.test(error)) return 'No pull request'
  return 'Pull request unavailable'
}

function viewedStorageKey(workspacePath: string, prNumber: number): string {
  return `vyotiq.prViewed:${workspacePath}:${prNumber}`
}

function loadViewed(workspacePath: string, prNumber: number): Set<string> {
  try {
    const raw = localStorage.getItem(viewedStorageKey(workspacePath, prNumber))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((p): p is string => typeof p === 'string'))
  } catch {
    return new Set()
  }
}

function saveViewed(workspacePath: string, prNumber: number, viewed: Set<string>): void {
  try {
    localStorage.setItem(
      viewedStorageKey(workspacePath, prNumber),
      JSON.stringify([...viewed])
    )
  } catch {
    /* ignore */
  }
}

function changeBadge(changeType: PrFile['changeType']): string | null {
  switch (changeType) {
    case 'ADDED':
      return 'New'
    case 'DELETED':
      return 'Deleted'
    case 'RENAMED':
      return 'Renamed'
    case 'COPIED':
      return 'Copied'
    case 'MODIFIED':
    case 'CHANGED':
    case 'UNKNOWN':
      return null
    default: {
      const _exhaustive: never = changeType
      return _exhaustive
    }
  }
}

function prStatusLetter(changeType: PrFile['changeType']): BrowserFileEntry['statusLetter'] {
  switch (changeType) {
    case 'ADDED':
      return 'A'
    case 'DELETED':
      return 'D'
    case 'RENAMED':
      return 'R'
    case 'COPIED':
      return 'C'
    case 'MODIFIED':
    case 'CHANGED':
    case 'UNKNOWN':
      return 'M'
    default: {
      const _exhaustive: never = changeType
      return _exhaustive
    }
  }
}

function toPrBrowserEntry(file: PrFile): BrowserFileEntry {
  const label = changeBadge(file.changeType)
  return {
    path: file.path,
    statusLetter: prStatusLetter(file.changeType),
    statusLabel: label,
    statusTone: label === 'New' ? 'success' : 'muted',
    added: file.additions,
    removed: file.deletions
  }
}

function needsGithubConnect(error: string | null, auth: GithubAuthStatus | null): boolean {
  if (auth?.pending) return true
  if (error && /auth|login|HTTP 401|HTTP 403/i.test(error)) return true
  return false
}

function checksLabel(pr: PrView): string {
  const total = pr.checks.length
  if (total === 0) return 'Checks'
  const passed = checksPassedCount(pr)
  return `Checks ${passed}/${total}`
}

function checksPassedCount(pr: PrView): number {
  return pr.checks.filter((c) => {
    const conclusion = (c.conclusion ?? c.state).toUpperCase()
    return conclusion === 'SUCCESS' || conclusion === 'PASSED' || conclusion === 'COMPLETED'
  }).length
}

function mergeMethodIcon(method: PrMergeMethod): IconName {
  switch (method) {
    case 'squash':
      return 'gitCommit'
    case 'merge':
      return 'gitMerge'
    case 'rebase':
      return 'gitRebase'
    default: {
      const _exhaustive: never = method
      return _exhaustive
    }
  }
}

function reviewsLabel(pr: PrView): string {
  const n = pr.latestReviews.length || pr.reviews.length
  return n > 0 ? `Reviews ${n}` : 'Reviews'
}

function ReviewCard({ review }: { review: PrReview }) {
  return (
    <li className="rounded-md border border-border/40 px-2.5 py-2 text-caption">
      <div className="flex items-center gap-2">
        <span className="font-medium text-fg">{review.author}</span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-muted">
          {review.state}
        </span>
        {review.submittedAt ? (
          <span className="ml-auto truncate text-muted">
            {new Date(review.submittedAt).toLocaleString()}
          </span>
        ) : null}
      </div>
      {review.body.trim() ? (
        <div className="mt-1.5 text-fg">
          <MarkdownContent content={review.body} className="text-caption" />
        </div>
      ) : (
        <p className="m-0 mt-1 text-muted">No review comment.</p>
      )}
    </li>
  )
}

/**
 * Docked PR panel backed by GitHub CLI (`gh`).
 */
export function PrPanel({
  workspacePath,
  className,
  onPrMeta,
  onUnlink,
  active = true,
  gitRevision = 0
}: {
  workspacePath?: string | null
  className?: string
  onPrMeta?: (meta: { number: number; title: string } | null) => void
  onUnlink?: () => void
  /** When false (hidden mounted dock), do not intercept Ctrl/Cmd+F/R. */
  active?: boolean
  /** Same clock as Changes — reloads PR metadata after git-mutating activity. */
  gitRevision?: number
}) {
  const [pr, setPr] = useState<PrView | null>(null)
  const [loading, setLoading] = useState(false)
  const loadSeqRef = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<PrTab>('changes')
  const [menuOpen, setMenuOpen] = useState(false)
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeFailed, setNoticeFailed] = useState(false)
  const [layout, setLayout] = useState<DiffLayout>('unified')
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [viewed, setViewed] = useState<Set<string>>(() => new Set())
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [preferredMerge, setPreferredMerge] = useState<PrMergeMethod>('squash')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [auth, setAuth] = useState<GithubAuthStatus | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const headerMenusRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  /** Keep latest callback without putting it in `load` deps (avoids prView spam). */
  const onPrMetaRef = useRef(onPrMeta)
  onPrMetaRef.current = onPrMeta

  const closeMenus = useCallback(() => {
    setMenuOpen(false)
    setMergeOpen(false)
    setLayoutOpen(false)
  }, [])

  useEffect(() => {
    if (!menuOpen && !mergeOpen && !layoutOpen) return undefined
    const onPointerDown = (e: PointerEvent): void => {
      if (headerMenusRef.current && !headerMenusRef.current.contains(e.target as Node)) {
        closeMenus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen, mergeOpen, layoutOpen, closeMenus])

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!workspacePath || !window.vyotiq?.prView) {
      if (seq !== loadSeqRef.current) return
      setPr(null)
      onPrMetaRef.current?.(null)
      setError(
        !window.vyotiq?.prView
          ? 'PR IPC unavailable'
          : 'Open a workspace to view a pull request.'
      )
      return
    }
    setLoading(true)
    setError(null)
    try {
      if (window.vyotiq.githubAuthStatus) {
        const authRes = await window.vyotiq.githubAuthStatus()
        if (seq === loadSeqRef.current && authRes.ok) setAuth(authRes.data)
      }
      const res = await window.vyotiq.prView(workspacePath)
      if (seq !== loadSeqRef.current) return
      if (!res.ok) {
        setPr(null)
        onPrMetaRef.current?.(null)
        setError(res.error)
        return
      }
      setPr(res.data)
      onPrMetaRef.current?.(
        res.data ? { number: res.data.number, title: res.data.title } : null
      )
      if (res.data) {
        setViewed(loadViewed(workspacePath, res.data.number))
        setTitleDraft(res.data.title)
      } else {
        setError('No pull request for this branch.')
      }
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [workspacePath])

  const refreshAuth = useCallback(async () => {
    if (!window.vyotiq?.githubAuthStatus) return
    const res = await window.vyotiq.githubAuthStatus()
    if (res.ok) setAuth(res.data)
  }, [])

  useEffect(() => {
    if (!auth?.pending) return undefined
    const id = window.setInterval(() => {
      void refreshAuth().then(() => {
        void load()
      })
    }, 2000)
    return () => window.clearInterval(id)
  }, [auth?.pending, refreshAuth, load])

  const connectGithub = useCallback(async () => {
    if (!window.vyotiq?.githubAuthStart) return
    setAuthBusy(true)
    setNotice(null)
    try {
      const res = await window.vyotiq.githubAuthStart()
      if (res.ok) {
        setAuth(res.data)
        setNotice(
          res.data.userCode
            ? `Enter code ${res.data.userCode} in the browser to finish connecting.`
            : 'Complete authorization in your browser.'
        )
        setNoticeFailed(false)
      } else {
        setNotice(res.error)
        setNoticeFailed(true)
      }
    } finally {
      setAuthBusy(false)
    }
  }, [])

  const openExternal = useCallback(async (url: string) => {
    if (!window.vyotiq?.shellOpenExternal) return
    const res = await window.vyotiq.shellOpenExternal(url)
    if (!res.ok) {
      setNotice(res.error)
      setNoticeFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, gitRevision])

  useEffect(() => {
    setExpanded(new Set())
    setFindQuery('')
    setFindOpen(false)
    setEditingTitle(false)
  }, [workspacePath])

  useEffect(() => {
    if (!findOpen) return
    findInputRef.current?.focus()
  }, [findOpen])

  useEffect(() => {
    if (!editingTitle) return
    titleInputRef.current?.focus()
    titleInputRef.current?.select()
  }, [editingTitle])

  const merge = useCallback(
    async (method: PrMergeMethod) => {
      if (!workspacePath || !window.vyotiq?.prMerge || !pr) return
      const confirmed = window.confirm(
        `Merge PR #${pr.number} using ${method}? This cannot be undone from the app.`
      )
      if (!confirmed) return
      setPreferredMerge(method)
      setMergeBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      closeMenus()
      try {
        const res = await window.vyotiq.prMerge(workspacePath, method)
        if (res.ok) {
          setNotice(res.data.detail)
          setNoticeFailed(false)
          void load()
        } else {
          setNotice(res.error)
          setNoticeFailed(true)
        }
      } finally {
        setMergeBusy(false)
      }
    },
    [workspacePath, load, closeMenus, pr]
  )

  const togglePath = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggleViewed = useCallback(
    (path: string) => {
      if (!workspacePath || !pr) return
      setViewed((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        saveViewed(workspacePath, pr.number, next)
        return next
      })
    },
    [workspacePath, pr]
  )

  const expandAll = useCallback(() => {
    if (!pr) return
    const EXPAND_ALL_MAX = 12
    setExpanded(new Set(pr.files.slice(0, EXPAND_ALL_MAX).map((f) => f.path)))
    closeMenus()
  }, [pr, closeMenus])

  const collapseAll = useCallback(() => {
    setExpanded(new Set())
    closeMenus()
  }, [closeMenus])

  const fetchPrDiff = useCallback(
    async (path: string) => {
      if (!workspacePath) return { error: 'No workspace' }
      const res = await window.vyotiq.prDiff({
        workspacePath,
        path,
        ignoreWhitespace
      })
      if (!res.ok) return { error: res.error }
      return { content: res.data.content }
    },
    [workspacePath, ignoreWhitespace]
  )

  const browserFiles = useMemo(
    () => (pr ? pr.files.map(toPrBrowserEntry) : []),
    [pr]
  )

  const filteredBrowserFiles = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    if (!q) return browserFiles
    return browserFiles.filter((f) => f.path.toLowerCase().includes(q))
  }, [browserFiles, findQuery])

  const showConnect = needsGithubConnect(error, auth)

  const connectActions = (
    <>
      {auth && !auth.clientIdConfigured ? (
        <p className="m-0 w-full text-caption text-muted">
          Set a GitHub client ID in Settings → Agent (or VYOTIQ_GITHUB_CLIENT_ID) before connecting.
        </p>
      ) : null}
      <Button
        variant="subtle"
        className="h-7 px-2.5 text-caption"
        disabled={
          authBusy ||
          Boolean(auth?.pending) ||
          Boolean(auth && !auth.clientIdConfigured)
        }
        onClick={() => void connectGithub()}
      >
        {auth?.pending ? 'Waiting…' : 'Connect GitHub'}
      </Button>
      {auth?.pending && auth.verificationUri ? (
        <Button
          variant="subtle"
          className="h-7 px-2.5 text-caption"
          onClick={() => void openExternal(auth.verificationUri!)}
        >
          Open verification
        </Button>
      ) : null}
      {auth?.pending ? (
        <Button
          variant="subtle"
          className="h-7 px-2.5 text-caption"
          disabled={authBusy}
          onClick={() => {
            void window.vyotiq.githubAuthCancel?.().then((res) => {
              if (res.ok) setAuth(res.data)
            })
          }}
        >
          Cancel
        </Button>
      ) : null}
      {auth?.hasAppToken ? (
        <Button
          variant="subtle"
          className="h-7 px-2.5 text-caption"
          onClick={() => {
            void window.vyotiq.githubAuthLogout?.().then((res) => {
              if (res.ok) setAuth(res.data)
              void load()
            })
          }}
        >
          Disconnect
        </Button>
      ) : null}
    </>
  )

  const closePr = useCallback(async () => {
    if (!workspacePath || !window.vyotiq?.prClose || !pr) return
    const confirmed = window.confirm(
      `Close PR #${pr.number}? The pull request will be closed on GitHub.`
    )
    if (!confirmed) return
    closeMenus()
    setNotice(null)
    setNoticeFailed(false)
    const res = await window.vyotiq.prClose(workspacePath)
    if (res.ok) {
      setNotice(res.data.detail)
      setNoticeFailed(false)
      void load()
    } else {
      setNotice(res.error)
      setNoticeFailed(true)
    }
  }, [workspacePath, load, closeMenus, pr])

  const saveTitle = useCallback(async () => {
    if (!workspacePath || !window.vyotiq?.prEditTitle || !pr) return
    const next = titleDraft.trim()
    if (!next || next === pr.title) {
      setEditingTitle(false)
      setTitleDraft(pr.title)
      return
    }
    const res = await window.vyotiq.prEditTitle(workspacePath, next)
    if (res.ok) {
      setPr((curr) => (curr ? { ...curr, title: res.data.title } : curr))
      onPrMeta?.({ number: pr.number, title: res.data.title })
      setEditingTitle(false)
      setNotice('Title updated')
      setNoticeFailed(false)
    } else {
      setNotice(res.error)
      setNoticeFailed(true)
    }
  }, [workspacePath, pr, titleDraft, onPrMeta])

  const startEditTitle = useCallback(() => {
    if (!pr) return
    closeMenus()
    setTitleDraft(pr.title)
    setEditingTitle(true)
  }, [pr, closeMenus])

  useEffect(() => {
    if (!pr || !active) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (matchShortcut(e, 'refresh')) {
        e.preventDefault()
        void load()
        return
      }
      if (matchShortcut(e, 'find') && tab === 'changes') {
        e.preventDefault()
        setFindOpen(true)
        return
      }
      if (e.shiftKey && e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        startEditTitle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pr, load, tab, startEditTitle, active])

  const mergeLabel = useMemo(() => {
    switch (preferredMerge) {
      case 'squash':
        return 'Squash & Merge'
      case 'merge':
        return 'Merge'
      case 'rebase':
        return 'Rebase Merge'
      default: {
        const _exhaustive: never = preferredMerge
        return _exhaustive
      }
    }
  }, [preferredMerge])

  return (
    <div
      className={cn(CHAT_RIGHT_PANEL_BODY, className)}
      data-pr-panel
      role="region"
      aria-label="Pull request panel"
    >
      {pr ? (
        <div className="flex shrink-0 flex-col gap-1 border-b border-border/40 px-2.5 py-2">
          <div className="flex h-7 min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-success/20 px-1.5 py-0.5 text-2xs font-medium leading-none text-success">
              {formatPrState(pr.state)}
            </span>
            <span className="min-w-0 flex-1 truncate text-caption leading-none text-muted" title={`${pr.headRefName} → ${pr.baseRefName}`}>
              {pr.headRefName} → {pr.baseRefName}
            </span>
            <div
              ref={headerMenusRef}
              className="flex shrink-0 items-center gap-1"
            >
              <div className="relative">
                <Tooltip content="PR actions">
                  <button
                    type="button"
                    className={DOCK_TOOLBAR_ICON_BTN}
                    aria-label="PR actions"
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
                        className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                        onClick={() => setLayoutOpen((v) => !v)}
                      >
                        <span>Layout</span>
                        <span className="text-muted">
                          {layout === 'unified' ? 'Unified' : 'Split'} ›
                        </span>
                      </button>
                      {layoutOpen ? (
                        <div className="absolute left-0 top-0 z-dropdown min-w-[8rem] -translate-x-full rounded-md border border-border bg-bg py-1 shadow-lg">
                          {(
                            [
                              ['unified', 'Unified'],
                              ['split', 'Split']
                            ] as const
                          ).map(([id, label]) => (
                            <button
                              key={id}
                              type="button"
                              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                              onClick={() => {
                                setLayout(id)
                                setLayoutOpen(false)
                              }}
                            >
                              <span className="w-3">{layout === id ? '✓' : ''}</span>
                              {label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <label className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-caption hover:bg-surface">
                      <span>Ignore Whitespace</span>
                      <Switch
                        checked={ignoreWhitespace}
                        onCheckedChange={setIgnoreWhitespace}
                        label="Ignore Whitespace"
                      />
                    </label>
                    <label className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-caption hover:bg-surface">
                      <span>Word Wrap</span>
                      <Switch
                        checked={wordWrap}
                        onCheckedChange={setWordWrap}
                        label="Word Wrap"
                      />
                    </label>
                    <div className="my-1 border-t border-border/50" />
                    <button
                      type="button"
                      className="flex w-full px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                      onClick={expandAll}
                    >
                      Expand All Files
                    </button>
                    <button
                      type="button"
                      className="flex w-full px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                      onClick={collapseAll}
                    >
                      Collapse All
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                      onClick={() => {
                        closeMenus()
                        setFindOpen(true)
                        setTab('changes')
                      }}
                    >
                      <span>Find in Diff</span>
                      <span className="text-muted">{shortcutLabel('find')}</span>
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                      onClick={() => {
                        closeMenus()
                        void load()
                      }}
                    >
                      <span>Refresh Changes</span>
                      <span className="text-muted">{shortcutLabel('refresh')}</span>
                    </button>
                    <button
                      type="button"
                      className="flex w-full px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                      onClick={() => {
                        closeMenus()
                        void openExternal(pr.url)
                      }}
                    >
                      View on Web
                    </button>
                    <button
                      type="button"
                      className="flex w-full px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                      onClick={() => {
                        closeMenus()
                        void navigator.clipboard.writeText(pr.url)
                      }}
                    >
                      Copy URL
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                      onClick={startEditTitle}
                    >
                      <span>Edit Title</span>
                      <span className="text-muted">Shift+Alt+T</span>
                    </button>
                    <div className="my-1 border-t border-border/50" />
                    <button
                      type="button"
                      className="flex w-full px-2.5 py-1.5 text-left text-caption text-danger hover:bg-surface"
                      onClick={() => void closePr()}
                    >
                      Close PR
                    </button>
                    <button
                      type="button"
                      className="flex w-full px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                      onClick={() => {
                        closeMenus()
                        onPrMeta?.(null)
                        onUnlink?.()
                      }}
                    >
                      Unlink PR
                    </button>
                  </div>
                ) : null}
              </div>
              <DockSplitButton
                primaryClassName="text-success"
                primaryLabel={mergeLabel}
                primaryIcon={
                  <Icon name={mergeMethodIcon(preferredMerge)} size={12} className="shrink-0" />
                }
                primaryDisabled={mergeBusy}
                onPrimaryClick={() => void merge(preferredMerge)}
                menuOpen={mergeOpen}
                onMenuToggle={() => {
                  const next = !mergeOpen
                  closeMenus()
                  setMergeOpen(next)
                }}
                menuAriaLabel="Merge method"
                menu={
                  mergeOpen ? (
                    <div className="absolute right-0 top-full z-dropdown mt-0.5 min-w-[11rem] overflow-visible rounded-md border border-border bg-bg py-1 shadow-lg">
                      <p className="m-0 px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-muted">
                        Merge Method
                      </p>
                      {(
                        [
                          ['squash', 'Squash & Merge'],
                          ['merge', 'Merge'],
                          ['rebase', 'Rebase Merge']
                        ] as const
                      ).map(([method, label]) => (
                        <button
                          key={method}
                          type="button"
                          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption hover:bg-surface"
                          disabled={mergeBusy}
                          onClick={() => void merge(method)}
                        >
                          <Icon name={mergeMethodIcon(method)} size={12} className="shrink-0 text-muted" />
                          <span className="min-w-0 flex-1 whitespace-nowrap">{label}</span>
                          <span className="w-3 text-success">
                            {preferredMerge === method ? '✓' : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null
                }
              />
            </div>
          </div>
          {editingTitle ? (
            <form
              className="flex min-w-0 items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault()
                void saveTitle()
              }}
            >
              <input
                ref={titleInputRef}
                type="text"
                className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                value={titleDraft}
                aria-label="PR title"
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    setEditingTitle(false)
                    setTitleDraft(pr.title)
                  }
                }}
              />
              <Button
                type="submit"
                variant="subtle"
                className="h-7 px-2 text-caption"
              >
                Save
              </Button>
            </form>
          ) : (
            <p className="m-0 truncate text-xs font-medium text-fg" title={pr.title}>
              {pr.title} #{pr.number}
            </p>
          )}
          <div className="flex gap-1 overflow-x-auto">
            {(
              [
                ['changes', `Changes ${pr.files.length}`],
                ['description', 'Description'],
                ['commits', `Commits ${pr.commits.length}`],
                ['checks', checksLabel(pr)],
                ['reviews', reviewsLabel(pr)]
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={cn(
                  'relative shrink-0 rounded px-2 py-1 text-caption',
                  tab === id ? 'bg-bg text-fg underline decoration-accent' : 'text-muted hover:text-fg'
                )}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
                {id === 'checks' && pr.checks.length > 0 ? (
                  <span
                    className="mt-0.5 block h-0.5 w-full overflow-hidden rounded-full bg-surface-2"
                    aria-hidden
                  >
                    <span
                      className="block h-full bg-success"
                      style={{
                        width: `${Math.round(
                          (checksPassedCount(pr) / Math.max(pr.checks.length, 1)) * 100
                        )}%`
                      }}
                    />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {notice ? (
        <p
          className={cn(
            'm-0 shrink-0 border-b border-border/40 px-3 py-1 text-caption',
            noticeFailed ? 'text-danger' : 'text-success'
          )}
          role={noticeFailed ? 'alert' : 'status'}
        >
          {notice}
        </p>
      ) : null}

      {findOpen && pr && tab === 'changes' ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-2 py-1">
          <input
            ref={findInputRef}
            type="search"
            className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-caption text-fg"
            value={findQuery}
            placeholder="Find in diff…"
            aria-label="Find in diff"
            onChange={(e) => setFindQuery(e.target.value)}
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
            className="rounded px-1.5 py-0.5 text-caption text-muted hover:bg-surface-2"
            aria-label="Close find"
            onClick={() => {
              setFindOpen(false)
              setFindQuery('')
            }}
          >
            ✕
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3">
        {loading ? (
          <p className="m-0 text-xs text-muted">Loading…</p>
        ) : !pr ? (
          <EmptyPanel
            icon="pullRequest"
            title={prEmptyTitle(error)}
            body={
              showConnect
                ? auth?.userCode
                  ? `Enter ${auth.userCode} at GitHub to authorize VYOTIQ.`
                  : 'Connect GitHub to view pull requests for this branch.'
                : (error ?? 'Connect GitHub to view PRs for this branch.')
            }
            actions={showConnect || auth?.pending ? connectActions : undefined}
          />
        ) : tab === 'description' ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <MarkdownContent content={pr.body || '_No description_'} className="text-sm" />
          </div>
        ) : tab === 'commits' ? (
          <div className="min-h-0 flex-1 overflow-auto">
          {showConnect && pr.commits.length === 0 ? (
            <EmptyPanel
              icon="pullRequest"
              title="GitHub authentication required"
              body="Connect GitHub to load commits for this pull request."
              actions={connectActions}
            />
          ) : pr.commits.length === 0 ? (
            <p className="m-0 text-caption text-muted">No commits reported for this pull request.</p>
          ) : (
            <ul className="m-0 list-none space-y-1.5 p-0">
              {pr.commits.map((c) => (
                <li key={c.oid} className="rounded-md border border-border/40 px-2.5 py-1.5 text-caption">
                  <p className="m-0 text-fg">{c.messageHeadline}</p>
                  <p className="m-0 mt-0.5 truncate text-muted">
                    {c.oid.slice(0, 7)}
                    {c.authors.length ? ` · ${c.authors.join(', ')}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
          </div>
        ) : tab === 'checks' ? (
          <div className="min-h-0 flex-1 overflow-auto">
          <ul className="m-0 list-none space-y-1 p-0">
            {pr.checks.length === 0 ? (
              <li className="text-caption text-muted">
                No CI checks configured — they&apos;ll appear here once set up.
              </li>
            ) : (
              pr.checks.map((c, i) => (
                <li
                  key={`${c.name}-${i}`}
                  className="flex items-center gap-2 rounded-md border border-border/40 px-2.5 py-1.5 text-caption"
                >
                  <span className="min-w-0 flex-1 truncate text-fg">{c.name}</span>
                  <span className="shrink-0 text-muted">{c.conclusion ?? c.state}</span>
                </li>
              ))
            )}
          </ul>
          </div>
        ) : tab === 'reviews' ? (
          <div className="min-h-0 flex-1 space-y-3 overflow-auto">
            {showConnect &&
            (pr.latestReviews.length ? pr.latestReviews : pr.reviews).length === 0 ? (
              <EmptyPanel
                icon="pullRequest"
                title="GitHub authentication required"
                body="Connect GitHub to load reviews for this pull request."
                actions={
                  <>
                    {connectActions}
                    <Button
                      variant="subtle"
                      className="h-7 px-2.5 text-caption"
                      onClick={() => void openExternal(pr.url)}
                    >
                      View on Web
                    </Button>
                  </>
                }
              />
            ) : (
              <>
                {pr.reviewDecision ? (
                  <p className="m-0 text-caption text-muted">
                    Decision:{' '}
                    <span className="font-medium text-fg">{pr.reviewDecision}</span>
                  </p>
                ) : null}
                {pr.reviewRequests.length > 0 ? (
                  <p className="m-0 text-caption text-muted">
                    Requested: {pr.reviewRequests.join(', ')}
                  </p>
                ) : null}
                {(pr.latestReviews.length ? pr.latestReviews : pr.reviews).length === 0 ? (
                  <p className="m-0 text-caption text-muted">No reviews yet for this pull request.</p>
                ) : (
                  <ul className="m-0 list-none space-y-2 p-0">
                    {(pr.latestReviews.length ? pr.latestReviews : pr.reviews).map((r, i) => (
                      <ReviewCard key={`${r.author}-${r.submittedAt ?? i}`} review={r} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            {pr.files.length === 0 ? (
              <p className="m-0 text-caption text-muted">No files changed.</p>
            ) : (
              <ChangedFilesBrowser
                className="min-h-0 flex-1"
                files={filteredBrowserFiles}
                totals={{ added: pr.additions, removed: pr.deletions }}
                expanded={expanded}
                onToggleExpand={togglePath}
                selectedPath={selectedPath}
                onSelectPath={setSelectedPath}
                fetchDiff={fetchPrDiff}
                layout={layout}
                wordWrap={wordWrap}
                findQuery={findQuery}
                viewedPaths={viewed}
                onToggleViewed={toggleViewed}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
