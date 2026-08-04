import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@renderer/lib/ui/cn'
import { CHAT_RIGHT_PANEL_BODY } from '@renderer/lib/utils/layout'
import type { AgentBrowserState } from '@shared/ipc'
import {
  clearBrowserRecents,
  filterBrowserRecents,
  groupBrowserRecents,
  loadBrowserRecents,
  recordBrowserVisit,
  type BrowserRecent
} from './browserRecents'

const EMPTY: AgentBrowserState = {
  open: false,
  url: '',
  title: '',
  navigating: false,
  tabs: [],
  canGoBack: false,
  canGoForward: false
}

const BOOKMARK_BAR_KEY = 'vyotiq.browserBookmarkBar'

/**
 * Docked right-side panel hosting the main-process `WebContentsView`.
 * Styled to match Cursor's built-in browser chrome.
 */
export function AgentBrowserPanel({
  className,
  workspacePath,
  activeRunId,
  visible = true,
  onClose
}: {
  className?: string
  workspacePath?: string | null
  activeRunId?: string | null
  /** When false (CSS-hidden dock tab), clear native WebContentsView bounds so the overlay does not paint over other panels. */
  visible?: boolean
  onClose?: () => void
}) {
  const [state, setState] = useState<AgentBrowserState>(EMPTY)
  const [urlInput, setUrlInput] = useState('')
  const [urlFocused, setUrlFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [recents, setRecents] = useState<BrowserRecent[]>(() => loadBrowserRecents())
  const [bookmarkBar, setBookmarkBar] = useState(() => {
    try {
      return localStorage.getItem(BOOKMARK_BAR_KEY) === '1'
    } catch {
      return false
    }
  })
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const lastRecordedUrl = useRef('')

  useEffect(() => {
    let cancelled = false
    void window.vyotiq.browserGetState?.().then((res) => {
      if (cancelled || !res.ok) return
      setState(res.data)
    })
    const unsub = window.vyotiq.onBrowserState?.((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  useEffect(() => {
    if (!urlFocused) setUrlInput(state.url?.trim() || '')
  }, [state.url, urlFocused])

  useEffect(() => {
    const url = state.url?.trim() || ''
    if (!url || url === 'about:blank') {
      lastRecordedUrl.current = ''
      return
    }
    if (url === lastRecordedUrl.current) return
    lastRecordedUrl.current = url
    setRecents(recordBrowserVisit(url, state.title ?? ''))
  }, [state.url, state.title])

  useLayoutEffect(() => {
    if (!visible) {
      void window.vyotiq.browserSetBounds?.(null)
      return undefined
    }

    const el = viewportRef.current
    if (!el) return undefined

    let cancelled = false
    const report = (): void => {
      if (cancelled) return
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      // Dock is open ⇒ side rail is hidden; use the viewport box as-is.
      void window.vyotiq.browserSetBounds?.({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }

    report()
    const raf = requestAnimationFrame(report)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(report) : null
    ro?.observe(el)
    window.addEventListener('resize', report)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', report)
      void window.vyotiq.browserSetBounds?.(null)
    }
  }, [visible])

  useEffect(() => {
    if (!menuOpen && !historyOpen) return
    const handler = (e: MouseEvent): void => {
      const target = e.target as Node
      if (menuOpen && menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false)
      }
      if (historyOpen && historyRef.current && !historyRef.current.contains(target)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen, historyOpen])

  useEffect(() => {
    if (!statusMsg) return
    const t = window.setTimeout(() => setStatusMsg(null), 2500)
    return () => window.clearTimeout(t)
  }, [statusMsg])

  const tabs = state.tabs ?? []
  const hasPage = Boolean(state.open) && tabs.length > 0
  const filteredRecents = useMemo(
    () => filterBrowserRecents(recents, urlFocused ? urlInput : ''),
    [recents, urlFocused, urlInput]
  )
  const recentGroups = useMemo(() => groupBrowserRecents(filteredRecents), [filteredRecents])

  const navigateTo = useCallback((raw: string) => {
    let target = raw.trim()
    if (!target) return
    if (!/^https?:\/\//i.test(target)) {
      if (/^[a-z0-9-]+\.[a-z]{2,}/i.test(target)) {
        target = `https://${target}`
      } else {
        target = `https://www.google.com/search?q=${encodeURIComponent(target)}`
      }
    }
    void window.vyotiq.browserNavigate?.(target)
    setHistoryOpen(false)
    urlInputRef.current?.blur()
  }, [])

  const handleNavigate = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      navigateTo(urlInput)
    },
    [navigateTo, urlInput]
  )

  const handleMenuAction = useCallback(
    (action: string) => {
      setMenuOpen(false)
      switch (action) {
        case 'screenshot': {
          if (!workspacePath || !activeRunId) {
            setStatusMsg('Open a chat run to save a screenshot')
            break
          }
          void window.vyotiq
            .browserTakeScreenshot?.({ workspacePath, runId: activeRunId })
            .then((res) => {
              if (res?.ok) setStatusMsg('Screenshot saved to run artifacts')
              else setStatusMsg(res && !res.ok ? res.error : 'Screenshot failed')
            })
          break
        }
        case 'reload':
          void window.vyotiq.browserReload?.()
          break
        case 'copy-url':
          if (state.url) {
            void navigator.clipboard.writeText(state.url)
            setStatusMsg('URL copied')
          }
          break
        case 'bookmark-bar': {
          setBookmarkBar((prev) => {
            const next = !prev
            try {
              localStorage.setItem(BOOKMARK_BAR_KEY, next ? '1' : '0')
            } catch {
              /* ignore */
            }
            return next
          })
          break
        }
        case 'clear-history':
          void window.vyotiq.browserClearBrowsingData?.({ kind: 'history' }).then((res) => {
            if (!res?.ok) {
              setStatusMsg(res && !res.ok ? res.error : 'Failed to clear history')
              return
            }
            clearBrowserRecents()
            lastRecordedUrl.current = ''
            setRecents([])
            setStatusMsg('Browsing history cleared')
          })
          break
        case 'clear-cookies':
          void window.vyotiq.browserClearBrowsingData?.({ kind: 'cookies' }).then((res) => {
            if (!res?.ok) {
              setStatusMsg(res && !res.ok ? res.error : 'Failed to clear cookies')
              return
            }
            setStatusMsg('Cookies cleared')
          })
          break
        case 'clear-cache':
          void window.vyotiq.browserClearBrowsingData?.({ kind: 'cache' }).then((res) => {
            if (!res?.ok) {
              setStatusMsg(res && !res.ok ? res.error : 'Failed to clear cache')
              return
            }
            setStatusMsg('Cache cleared')
          })
          break
        case 'close':
          void window.vyotiq.browserClose?.()
          onClose?.()
          break
        default:
          break
      }
    },
    [activeRunId, onClose, state.url, workspacePath]
  )

  return (
    <div
      className={cn(CHAT_RIGHT_PANEL_BODY, className)}
      data-agent-browser-panel
      role="region"
      aria-label="Browser panel"
    >
      {tabs.length > 1 ? (
        <div className="flex gap-0.5 overflow-x-auto border-b border-border/30 bg-bg px-1.5 pt-1.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={cn(
                'flex max-w-[10rem] shrink-0 items-center gap-1 truncate rounded-t-md px-2 py-1 text-[11px]',
                tab.active
                  ? 'bg-surface font-medium text-fg'
                  : 'text-muted hover:bg-surface/60 hover:text-fg'
              )}
              title={`${tab.title || tab.id}\n${tab.url}`}
              onClick={() => {
                void window.vyotiq.browserSelectTab?.(tab.id)
              }}
            >
              <GlobeGlyph className="shrink-0 opacity-60" size={12} />
              <span className="truncate">{tab.title?.trim() || tab.id}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <NavIconButton
          label="Back"
          disabled={!state.canGoBack}
          onClick={() => void window.vyotiq.browserBack?.()}
        >
          <polyline points="15 18 9 12 15 6" />
        </NavIconButton>
        <NavIconButton
          label="Forward"
          disabled={!state.canGoForward}
          onClick={() => void window.vyotiq.browserForward?.()}
        >
          <polyline points="9 18 15 12 9 6" />
        </NavIconButton>
        <NavIconButton
          label="Reload"
          disabled={!hasPage}
          onClick={() => void window.vyotiq.browserReload?.()}
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </NavIconButton>

        <div className="relative min-w-0 flex-1" ref={historyRef}>
          <form onSubmit={handleNavigate}>
            <div
              className={cn(
                'flex items-center rounded-md border bg-surface px-2.5 py-1 text-[12px] transition-colors',
                urlFocused ? 'border-accent/60' : 'border-border/40'
              )}
            >
              {!urlFocused && hasPage ? (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="mr-1.5 shrink-0 text-muted"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              ) : null}
              <input
                ref={urlInputRef}
                type="text"
                className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
                placeholder="Search or enter URL"
                value={urlInput}
                onChange={(e) => {
                  setUrlInput(e.target.value)
                  setHistoryOpen(true)
                }}
                onFocus={() => {
                  setUrlFocused(true)
                  setHistoryOpen(true)
                  setTimeout(() => urlInputRef.current?.select(), 0)
                }}
                onBlur={() => {
                  // Delay so dropdown clicks can fire first.
                  window.setTimeout(() => {
                    setUrlFocused(false)
                    setUrlInput(state.url?.trim() || '')
                  }, 120)
                }}
                spellCheck={false}
              />
            </div>
          </form>

          {historyOpen && recentGroups.length > 0 ? (
            <div
              className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[min(50vh,320px)] overflow-auto rounded-lg border border-border/60 bg-surface py-1 shadow-lg"
              data-browser-history-dropdown
            >
              {recentGroups.map((group) => (
                <div key={group.label}>
                  <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">
                    {group.label}
                  </div>
                  {group.items.map((item) => (
                    <button
                      key={`${item.url}-${item.visitedAt}`}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-surface-2"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => navigateTo(item.url)}
                      title={item.url}
                    >
                      <GlobeGlyph className="shrink-0 text-muted" size={12} />
                      <span className="min-w-0 flex-1 truncate">
                        {item.title?.trim() || item.url}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-fg/70 transition-colors hover:bg-surface-2"
            onClick={() => setMenuOpen((v) => !v)}
            title="More actions"
            aria-label="More actions"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-[13rem] rounded-lg border border-border/60 bg-surface py-1 shadow-lg">
              <MenuButton
                onClick={() => handleMenuAction('screenshot')}
                disabled={!hasPage}
              >
                Take Screenshot
              </MenuButton>
              <div className="my-1 border-t border-border/30" />
              <MenuButton onClick={() => handleMenuAction('reload')} disabled={!hasPage}>
                Hard Reload
              </MenuButton>
              <MenuButton onClick={() => handleMenuAction('copy-url')} disabled={!state.url}>
                Copy Current URL
              </MenuButton>
              <div className="my-1 border-t border-border/30" />
              <MenuButton onClick={() => handleMenuAction('bookmark-bar')}>
                <span className="flex-1">Show Bookmark Bar</span>
                <span
                  className={cn(
                    'relative ml-2 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
                    bookmarkBar ? 'bg-accent' : 'bg-surface-2'
                  )}
                  aria-hidden
                >
                  <span
                    className={cn(
                      'inline-block size-3 rounded-full bg-fg transition-transform',
                      bookmarkBar ? 'translate-x-3.5' : 'translate-x-0.5'
                    )}
                  />
                </span>
              </MenuButton>
              <div className="my-1 border-t border-border/30" />
              <MenuButton onClick={() => handleMenuAction('clear-history')}>
                Clear Browsing History
              </MenuButton>
              <MenuButton onClick={() => handleMenuAction('clear-cookies')}>
                Clear Cookies
              </MenuButton>
              <MenuButton onClick={() => handleMenuAction('clear-cache')}>Clear Cache</MenuButton>
            </div>
          ) : null}
        </div>

        {/* Close lives on the dock tab bar; keep onClose for the overflow menu only. */}
      </div>

      {bookmarkBar ? (
        <div className="flex items-center gap-1 border-b border-border/30 px-2 py-1 text-[11px] text-muted">
          <span className="px-1">Bookmarks</span>
          {recents.slice(0, 5).map((item) => (
            <button
              key={item.url}
              type="button"
              className="max-w-[7rem] truncate rounded px-1.5 py-0.5 text-fg/80 hover:bg-surface-2"
              title={item.url}
              onClick={() => navigateTo(item.url)}
            >
              {item.title?.trim() || item.url}
            </button>
          ))}
        </div>
      ) : null}

      {statusMsg ? (
        <div className="px-2.5 py-1 text-[11px] text-muted" role="status">
          {statusMsg}
        </div>
      ) : null}

      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 bg-bg"
        data-agent-browser-viewport
      >
        {!hasPage ? (
          <div className="absolute inset-0 overflow-auto px-4 py-6">
            {recents.length > 0 ? (
              <div>
                <p className="mb-2 text-[11px] font-medium text-muted">Recents</p>
                <ul className="m-0 list-none space-y-1 p-0">
                  {recents.slice(0, 12).map((item) => (
                    <li key={`${item.url}-${item.visitedAt}`}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg hover:bg-surface-2"
                        onClick={() => navigateTo(item.url)}
                        title={item.url}
                      >
                        <GlobeGlyph className="shrink-0 text-muted" size={14} />
                        <span className="min-w-0 truncate">
                          {item.title?.trim() || item.url}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <GlobeGlyph className="mb-4 text-muted/40" size={48} />
                <p className="text-[12px] font-medium text-fg/80">No page loaded</p>
                <p className="mt-1 max-w-[16rem] text-[11px] leading-relaxed text-muted">
                  Enter a URL above, or ask the agent to open a page.
                </p>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function GlobeGlyph({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

function NavIconButton({
  children,
  label,
  disabled,
  onClick
}: {
  children: React.ReactNode
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="flex size-7 items-center justify-center rounded-md text-fg/70 transition-colors hover:bg-surface-2 disabled:opacity-30"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  )
}

function MenuButton({
  children,
  onClick,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}
