import { WebContentsView, session, type WebContents } from 'electron'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { IPC } from '../../shared/channels'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { assertPublicUrl, isSyncBlockedUrl } from '@main/agent/tools/webFetch'
import { getMainWindow } from '@main/app/window'
import { isAbortError } from '../../shared/errors'
import {
  formatInteractiveRefs,
  parseBrowserTarget,
  type BrowserElementRef
} from './agentBrowserRefs'

const PARTITION = 'persist:vyotiq-agent-browser'
const DEFAULT_NAV_TIMEOUT_MS = 30_000
const MAX_NAV_TIMEOUT_MS = 60_000
const DEFAULT_SNAPSHOT_CHARS = 40_000
const MAX_INTERACTIVE_REFS = 80
const SNAPSHOT_JPEG_QUALITY = 55
const PREVIEW_MAX_WIDTH = 960
const DEFAULT_WAIT_TIMEOUT_MS = 15_000
const MAX_WAIT_TIMEOUT_MS = 60_000
export const MAX_BROWSER_TABS = 16

type BrowserTab = {
  id: string
  view: WebContentsView
  lastRefs: Map<string, BrowserElementRef>
  workspacePath?: string
}

type EmbedBounds = { x: number; y: number; width: number; height: number }

export type AgentBrowserState = {
  open: boolean
  url: string
  title: string
  /** @deprecated Preview removed — live WebContentsView is embedded in-app. */
  snapshotDataUrl?: string | null
  /** True while a navigation is in flight. */
  navigating?: boolean
  tabs?: Array<{ id: string; title: string; url: string; active: boolean }>
  canGoBack?: boolean
  canGoForward?: boolean
}

const tabs = new Map<string, BrowserTab>()
let activeTabId: string | null = null
let lastState: AgentBrowserState = {
  open: false,
  url: '',
  title: '',
  navigating: false,
  tabs: [],
  canGoBack: false,
  canGoForward: false
}
/** Serialize navigate/click/type/snapshot per workspace (shared browser; cross-workspace concurrent). */
const browserOpChains = new Map<string, Promise<void>>()
const GLOBAL_BROWSER_LOCK_KEY = '__global__'
let tabSeq = 0
let embedBounds: EmbedBounds | null = null

function isTabDestroyed(tab: BrowserTab): boolean {
  try {
    return tab.view.webContents.isDestroyed()
  } catch {
    return true
  }
}

function tabContents(tab: BrowserTab): WebContents {
  return tab.view.webContents
}

function destroyTab(tab: BrowserTab): void {
  const main = getMainWindow()
  if (main && !main.isDestroyed()) {
    try {
      main.contentView.removeChildView(tab.view)
    } catch {
      // already detached
    }
  }
  if (!isTabDestroyed(tab)) {
    tab.view.webContents.close()
  }
  tabs.delete(tab.id)
}

function attachTabView(tab: BrowserTab): void {
  const main = getMainWindow()
  if (!main || main.isDestroyed()) return
  try {
    main.contentView.removeChildView(tab.view)
  } catch {
    // not attached yet
  }
  // Later children paint above the window's main WebContentsView.
  main.contentView.addChildView(tab.view)
}

function applyActiveViewBounds(): void {
  for (const tab of tabs.values()) {
    if (isTabDestroyed(tab)) continue
    const active = tab.id === activeTabId && tabs.size > 0
    const bounds = embedBounds
    if (!active || !bounds || bounds.width < 1 || bounds.height < 1) {
      tab.view.setVisible(false)
      tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      continue
    }

    attachTabView(tab)
    tab.view.setBounds(bounds)
    tab.view.setVisible(true)
    try {
      tab.view.webContents.setBackgroundThrottling(false)
    } catch {
      // older Electron
    }
  }
}

export function setAgentBrowserBounds(bounds: EmbedBounds | null): void {
  if (!bounds || bounds.width < 2 || bounds.height < 2) {
    // Keep prior bounds if the renderer reports a transient empty rect during layout.
    if (bounds != null && embedBounds) {
      applyActiveViewBounds()
      return
    }
    embedBounds = null
  } else {
    embedBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    }
  }
  applyActiveViewBounds()
}

function withBrowserLock<T>(fn: () => Promise<T>, workspacePath?: string): Promise<T> {
  const key = workspacePath && workspacePath.length > 0 ? workspacePath : GLOBAL_BROWSER_LOCK_KEY
  const prev = browserOpChains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  browserOpChains.set(key, tail)
  void tail.finally(() => {
    if (browserOpChains.get(key) === tail) browserOpChains.delete(key)
  })
  return run
}

function nextTabId(): string {
  tabSeq += 1
  return `t${tabSeq}`
}

function listTabStates(): Array<{ id: string; title: string; url: string; active: boolean }> {
  return [...tabs.values()].map((tab) => {
    const destroyed = isTabDestroyed(tab)
    const wc = destroyed ? null : tabContents(tab)
    return {
      id: tab.id,
      title: wc ? wc.getTitle() : '',
      url: wc ? wc.getURL() : '',
      active: tab.id === activeTabId
    }
  })
}

function navFlags(wc: WebContents | null): { canGoBack: boolean; canGoForward: boolean } {
  if (!wc || wc.isDestroyed()) return { canGoBack: false, canGoForward: false }
  const histWc = wc as WebContents & {
    canGoBack?: () => boolean
    canGoForward?: () => boolean
    navigationHistory?: { canGoBack: () => boolean; canGoForward: () => boolean }
  }
  const hist = histWc.navigationHistory
  if (hist) {
    return { canGoBack: hist.canGoBack(), canGoForward: hist.canGoForward() }
  }
  return {
    canGoBack: typeof histWc.canGoBack === 'function' ? histWc.canGoBack() : false,
    canGoForward: typeof histWc.canGoForward === 'function' ? histWc.canGoForward() : false
  }
}

function pushState(partial: Partial<AgentBrowserState>): void {
  lastState = { ...lastState, ...partial }
  const main = getMainWindow()
  if (!main || main.isDestroyed()) return
  main.webContents.send(IPC.browserState, lastState)
}

function emitCurrent(extra?: Partial<AgentBrowserState>): void {
  const tab = activeTabId ? tabs.get(activeTabId) : undefined
  const wc = tab && !isTabDestroyed(tab) ? tabContents(tab) : null
  if (!wc) {
    pushState({
      open: tabs.size > 0,
      url: '',
      title: '',
      navigating: false,
      tabs: listTabStates(),
      canGoBack: false,
      canGoForward: false,
      ...extra
    })
    applyActiveViewBounds()
    return
  }
  const flags = navFlags(wc)
  pushState({
    open: true,
    url: wc.getURL(),
    title: wc.getTitle(),
    tabs: listTabStates(),
    canGoBack: flags.canGoBack,
    canGoForward: flags.canGoForward,
    ...extra
  })
  applyActiveViewBounds()
}

function attachAgentSecurity(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    void withBrowserLock(async () => {
      if (tabs.size >= MAX_BROWSER_TABS) return
      const tab = createTab()
      activeTabId = tab.id
      try {
        await navigateUrlUnlocked(url, { tabId: tab.id })
      } catch {
        // ignore — SSRF / load failures leave blank tab
      }
    })
    return { action: 'deny' }
  })
  wc.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })

  const blockPrivateNav = (event: Electron.Event, url: string): void => {
    if (isSyncBlockedUrl(url)) event.preventDefault()
  }
  wc.on('will-navigate', blockPrivateNav)
  wc.on('will-redirect', blockPrivateNav)

  wc.on('did-finish-load', () => {
    void enforcePublicPage(wc)
  })
}

/** Blank the page if the settled URL is private/loopback (async DNS). */
async function enforcePublicPage(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return
  const url = wc.getURL()
  if (!url || url === 'about:blank' || url.startsWith('chrome-error://')) return
  try {
    await assertPublicUrl(url)
  } catch {
    if (wc.isDestroyed()) return
    void wc.loadURL('about:blank')
    emitCurrent()
  }
}

function createTab(workspacePath?: string): BrowserTab {
  if (tabs.size >= MAX_BROWSER_TABS) {
    throw new Error(
      `Browser tab limit (${MAX_BROWSER_TABS}) reached. Close a tab before opening another.`
    )
  }
  const ses = session.fromPartition(PARTITION)
  const id = nextTabId()
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      javascript: true
    }
  })

  attachAgentSecurity(view.webContents)

  const tab: BrowserTab = { id, view, lastRefs: new Map(), workspacePath }
  tabs.set(id, tab)

  attachTabView(tab)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  view.setVisible(false)
  try {
    view.webContents.setBackgroundThrottling(false)
  } catch {
    // ignore
  }

  view.webContents.on('destroyed', () => {
    tabs.delete(id)
    if (activeTabId === id) {
      const next = tabs.keys().next().value as string | undefined
      activeTabId = next ?? null
    }
    emitCurrent({ navigating: false })
  })

  view.webContents.on('did-navigate', () => {
    tab.lastRefs = new Map()
    if (activeTabId === id) emitCurrent()
  })
  view.webContents.on('did-navigate-in-page', () => {
    tab.lastRefs = new Map()
    if (activeTabId === id) emitCurrent()
  })
  view.webContents.on('page-title-updated', () => {
    if (activeTabId === id) emitCurrent()
  })

  return tab
}

function ensureTab(tabId?: string, workspacePath?: string): BrowserTab {
  if (tabId) {
    const existing = tabs.get(tabId)
    if (!existing || isTabDestroyed(existing)) {
      throw new Error(`Unknown browser tab_id: ${tabId}`)
    }
    return existing
  }
  if (activeTabId) {
    const active = tabs.get(activeTabId)
    if (active && !isTabDestroyed(active)) return active
  }
  const tab = createTab(workspacePath)
  activeTabId = tab.id
  return tab
}

function requireTab(tabId?: string): BrowserTab {
  if (tabId) {
    const existing = tabs.get(tabId)
    if (!existing || isTabDestroyed(existing)) {
      throw new Error(`Unknown browser tab_id: ${tabId}`)
    }
    return existing
  }
  if (!activeTabId) {
    throw new Error('No browser page open. Call browser_navigate or browser_tabs open first.')
  }
  const active = tabs.get(activeTabId)
  if (!active || isTabDestroyed(active)) {
    throw new Error('No browser page open. Call browser_navigate or browser_tabs open first.')
  }
  return active
}

function activateTab(tab: BrowserTab): void {
  activeTabId = tab.id
  applyActiveViewBounds()
  if (!isTabDestroyed(tab)) {
    tabContents(tab).focus()
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }
}

async function waitForLoad(
  wc: WebContents,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ arm: () => void; checkIdle: () => void; done: Promise<void> }> {
  throwIfAborted(signal)
  let armed = false
  let settled = false
  let resolveDone!: () => void
  let rejectDone!: (err: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const timer = setTimeout(() => {
    finish(() => rejectDone(new Error(`Navigation timed out after ${timeoutMs}ms`)))
  }, timeoutMs)

  const onAbort = (): void => {
    finish(() => {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      rejectDone(err)
    })
  }

  const onDone = (): void => {
    finish(() => resolveDone())
  }

  const onFail = (
    _event: Electron.Event,
    errorCode: number,
    errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean
  ): void => {
    if (!isMainFrame) return
    // -3 is ABORTED (often from a superseding navigation).
    if (errorCode === -3) return
    finish(() => rejectDone(new Error(errorDescription || `Navigation failed (${errorCode})`)))
  }

  const finish = (fn: () => void): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    wc.removeListener('did-finish-load', onDone)
    wc.removeListener('did-fail-load', onFail)
    wc.removeListener('did-stop-loading', onDone)
    fn()
  }

  /** Attach listeners before loadURL so fast loads cannot race past us. */
  const arm = (): void => {
    if (armed) return
    armed = true
    signal?.addEventListener('abort', onAbort, { once: true })
    wc.once('did-finish-load', onDone)
    wc.once('did-stop-loading', onDone)
    wc.on('did-fail-load', onFail)
  }

  /** Call after loadURL — resolves if navigation already finished (cache hit). */
  const checkIdle = (): void => {
    if (armed && !settled && !wc.isLoading()) {
      finish(() => resolveDone())
    }
  }

  return { arm, checkIdle, done }
}

/** Navigate the agent browser to a public http(s) URL. */
export async function navigateUrl(
  rawUrl: string,
  opts: {
    signal?: AbortSignal
    timeoutMs?: number
    tabId?: string
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => navigateUrlUnlocked(rawUrl, opts), opts.workspacePath)
}

async function navigateUrlUnlocked(
  rawUrl: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; tabId?: string; workspacePath?: string } = {}
): Promise<string> {
  const url = await assertPublicUrl(rawUrl)
  throwIfAborted(opts.signal)

  const timeoutMs = Math.min(
    MAX_NAV_TIMEOUT_MS,
    Math.max(1_000, opts.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS)
  )

  const tab = ensureTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)
  emitCurrent({ navigating: true })

  try {
    const { arm, checkIdle, done } = await waitForLoad(wc, opts.signal, timeoutMs)
    arm()
    await wc.loadURL(url.toString())
    checkIdle()
    await done
  } catch (err) {
    emitCurrent({ navigating: false })
    if (isAbortError(err)) throw err
    throw err
  }

  const finalUrl = wc.getURL()
  try {
    await assertPublicUrl(finalUrl)
  } catch (err) {
    void wc.loadURL('about:blank')
    emitCurrent({ navigating: false })
    throw err
  }

  tab.lastRefs = new Map()
  emitCurrent({ navigating: false })
  const title = wc.getTitle()
  return [`Navigated to ${finalUrl}`, `Title: ${title || '(none)'}`, `tab_id: ${tab.id}`].join('\n')
}

/** Accessibility text (+ optional JPEG on disk) for the current page. */
export async function snapshotPage(
  opts: {
    signal?: AbortSignal
    maxChars?: number
    runDir?: string
    tabId?: string
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => snapshotPageUnlocked(opts), opts.workspacePath)
}

async function snapshotPageUnlocked(
  opts: {
    signal?: AbortSignal
    maxChars?: number
    runDir?: string
    tabId?: string
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const tab = requireTab(opts.tabId)
  activateTab(tab)
  const wc = tabContents(tab)

  const maxChars = Math.max(1_000, opts.maxChars ?? DEFAULT_SNAPSHOT_CHARS)
  const url = wc.getURL()
  const title = wc.getTitle()

  type SnapshotPayload = {
    text: string
    viewport: { w: number; h: number }
    items: Array<{ selector: string; tag: string; role: string; name: string }>
  }

  const payload = (await wc.executeJavaScript(
    `(() => {
      const cssEscape = (value) => {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
        return String(value).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\\\\]^\`{|}~])/g, '\\\\$1')
      }
      const cssPath = (el) => {
        if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) {
          return '#' + cssEscape(el.id)
        }
        const testId = el.getAttribute('data-testid')
        if (testId && document.querySelectorAll('[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]').length === 1) {
          return '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]'
        }
        const parts = []
        let node = el
        while (node && node.nodeType === 1 && parts.length < 6) {
          const parent = node.parentElement
          if (!parent) {
            parts.unshift(node.tagName.toLowerCase())
            break
          }
          const tag = node.tagName.toLowerCase()
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName)
          const idx = siblings.indexOf(node) + 1
          parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + idx + ')' : tag)
          if (parent === document.body || parent === document.documentElement) {
            parts.unshift(parent.tagName.toLowerCase())
            break
          }
          node = parent
        }
        return parts.join(' > ')
      }
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') return false
        return true
      }
      const roleOf = (el) => {
        const explicit = el.getAttribute('role')
        if (explicit) return explicit
        const tag = el.tagName.toLowerCase()
        if (tag === 'a') return 'link'
        if (tag === 'button') return 'button'
        if (tag === 'input') return el.getAttribute('type') === 'submit' ? 'button' : 'textbox'
        if (tag === 'textarea') return 'textbox'
        if (tag === 'select') return 'combobox'
        if (el.isContentEditable) return 'textbox'
        return tag
      }
      const nameOf = (el) => {
        const labelled = el.getAttribute('aria-label')
          || el.getAttribute('placeholder')
          || el.getAttribute('name')
          || el.getAttribute('title')
          || (el.labels && el.labels[0] && el.labels[0].innerText)
          || (typeof el.value === 'string' ? el.value : '')
          || el.innerText
          || ''
        return String(labelled).replace(/\\s+/g, ' ').trim().slice(0, 80)
      }
      const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="menuitem"], [contenteditable="true"]'
      const items = []
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue
        items.push({
          selector: cssPath(el),
          tag: el.tagName,
          role: roleOf(el),
          name: nameOf(el)
        })
        if (items.length >= ${MAX_INTERACTIVE_REFS}) break
      }
      const title = document.title || ''
      const body = (document.body && (document.body.innerText || document.body.textContent)) || ''
      const text = (title ? title + '\\n\\n' : '') + String(body)
      return {
        text,
        viewport: { w: window.innerWidth || 0, h: window.innerHeight || 0 },
        items
      }
    })()`,
    true
  )) as SnapshotPayload

  throwIfAborted(opts.signal)

  const refs: BrowserElementRef[] = (payload?.items ?? []).map((item, i) => ({
    id: `e${i + 1}`,
    selector: item.selector,
    tag: item.tag,
    role: item.role,
    name: item.name
  }))
  tab.lastRefs = new Map(refs.map((r) => [r.id, r]))

  let imageNote = ''
  try {
    let image = await wc.capturePage()
    const size = image.getSize()
    if (size.width > PREVIEW_MAX_WIDTH) {
      image = image.resize({ width: PREVIEW_MAX_WIDTH, quality: 'better' })
    }
    const jpeg = image.toJPEG(SNAPSHOT_JPEG_QUALITY)
    if (opts.runDir) {
      const dir = join(opts.runDir, 'browser')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'snapshot.jpg'), jpeg)
      imageNote = `\n\n[Screenshot saved under run browser/snapshot.jpg (${jpeg.length} bytes)]`
    }
    // Live embed shows the page; JPEG is also loaded in the chat snapshot card.
  } catch (err) {
    imageNote = `\n\n[Screenshot capture failed: ${err instanceof Error ? err.message : String(err)}]`
  }

  const bodyBudget = Math.max(500, maxChars - 2_000)
  const body = String(payload?.text ?? '').slice(0, bodyBudget)
  const viewport = payload?.viewport
  const viewportLine =
    viewport && viewport.w > 0
      ? `Viewport: ${viewport.w}x${viewport.h}`
      : 'Viewport: (unknown)'
  const interactive = [
    'Interactive elements (use @eN with browser_click / browser_type):',
    formatInteractiveRefs(refs)
  ].join('\n')

  return (
    [
      `URL: ${url}`,
      `Title: ${title || '(none)'}`,
      `tab_id: ${tab.id}`,
      viewportLine,
      '',
      interactive,
      '',
      body
    ].join('\n') + imageNote
  )
}

type ElementHit = {
  x: number
  y: number
  tag: string
  label: string
  matchIndex: number
  matchCount: number
  css: string
}

const SETTLE_FALLBACK_MS = 1_200
const SETTLE_NAV_TIMEOUT_MS = 8_000

async function settleAfterAction(
  wc: WebContents,
  signal: AbortSignal | undefined,
  opts: { waitForNav?: boolean; settleMs?: number } = {}
): Promise<void> {
  throwIfAborted(signal)
  const settleMs = Math.max(0, opts.settleMs ?? SETTLE_FALLBACK_MS)
  const fallback = new Promise<void>((resolve) => setTimeout(resolve, settleMs))
  if (!opts.waitForNav) {
    await fallback
    throwIfAborted(signal)
    return
  }
  const nav = new Promise<void>((resolve) => {
    const done = (): void => {
      wc.removeListener('did-finish-load', done)
      wc.removeListener('did-navigate-in-page', done)
      resolve()
    }
    wc.once('did-finish-load', done)
    wc.once('did-navigate-in-page', done)
    setTimeout(done, SETTLE_NAV_TIMEOUT_MS)
  })
  await Promise.race([nav, fallback])
  throwIfAborted(signal)
}

async function resolveSelector(
  tab: BrowserTab,
  selector: string
): Promise<ElementHit> {
  const wc = tabContents(tab)
  const target = parseBrowserTarget(selector)
  let css = target.kind === 'css' ? target.selector : ''
  if (target.kind === 'ref') {
    const ref = tab.lastRefs.get(target.id)
    if (!ref) {
      throw new Error(
        `Unknown snapshot ref @${target.id}. Call browser_snapshot first and use a listed @eN ref.`
      )
    }
    css = ref.selector
  }

  const hit = (await wc.executeJavaScript(
    `(() => {
      const css = ${JSON.stringify(css)}
      const all = Array.from(document.querySelectorAll(css))
      const interactable = (el) => {
        if (!el || el.nodeType !== 1) return false
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false
        if (Number(style.opacity || '1') === 0) return false
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        return true
      }
      const candidates = all.filter(interactable)
      if (candidates.length === 0) {
        return { error: all.length === 0 ? 'none' : 'hidden', matchCount: all.length }
      }
      const el = candidates[0]
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
      if (typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }) } catch { el.focus() }
      }
      const r = el.getBoundingClientRect()
      const x = Math.round(r.left + r.width / 2)
      const y = Math.round(r.top + r.height / 2)
      const top = document.elementFromPoint(x, y)
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        // Still click the intended element; report overlay for debugging.
      }
      el.classList.add('vyotiq-agent-hit')
      if (!document.getElementById('vyotiq-agent-hit-style')) {
        const style = document.createElement('style')
        style.id = 'vyotiq-agent-hit-style'
        style.textContent = '.vyotiq-agent-hit{outline:2px solid #2563eb !important;outline-offset:2px !important;}'
        document.documentElement.appendChild(style)
      }
      setTimeout(() => { try { el.classList.remove('vyotiq-agent-hit') } catch {} }, 1000)
      const label = (
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('name') ||
        (typeof el.value === 'string' ? el.value : '') ||
        el.innerText ||
        ''
      ).slice(0, 120)
      return {
        x, y,
        tag: el.tagName,
        label: String(label).trim(),
        matchIndex: 0,
        matchCount: candidates.length,
        css
      }
    })()`,
    true
  )) as
    | (ElementHit & { error?: undefined })
    | { error: string; matchCount: number }
    | null

  if (!hit || 'error' in hit) {
    const reason =
      hit && 'error' in hit && hit.error === 'hidden'
        ? `matched ${hit.matchCount} node(s) but none were interactable`
        : 'no matches'
    throw new Error(
      target.kind === 'ref'
        ? `Snapshot ref @${target.id} ${reason} (css=${css})`
        : `No interactable element for selector: ${selector} (${reason})`
    )
  }
  return hit
}

/** Click a CSS-selected element in the agent browser (via mouse input events). */
export async function clickSelector(
  selector: string,
  opts: {
    signal?: AbortSignal
    button?: 'left' | 'right' | 'middle'
    tabId?: string
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => clickSelectorUnlocked(selector, opts), opts.workspacePath)
}

async function clickSelectorUnlocked(
  selector: string,
  opts: {
    signal?: AbortSignal
    button?: 'left' | 'right' | 'middle'
    tabId?: string
    settleMs?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const sel = String(selector ?? '').trim()
  if (!sel) throw new Error('selector is required')

  const tab = requireTab(opts.tabId)
  activateTab(tab)
  const wc = tabContents(tab)

  const hit = await resolveSelector(tab, sel)
  throwIfAborted(opts.signal)

  const button = opts.button ?? 'left'
  wc.sendInputEvent({
    type: 'mouseDown',
    x: hit.x,
    y: hit.y,
    button,
    clickCount: 1
  })
  wc.sendInputEvent({
    type: 'mouseUp',
    x: hit.x,
    y: hit.y,
    button,
    clickCount: 1
  })

  await settleAfterAction(wc, opts.signal, { waitForNav: true, settleMs: opts.settleMs })
  emitCurrent()
  const label = hit.label ? ` "${hit.label}"` : ''
  const amb =
    hit.matchCount > 1 ? ` (match 1 of ${hit.matchCount} interactable)` : ''
  return `Clicked ${hit.tag}${label} at (${hit.x}, ${hit.y}) via ${sel}${amb}`
}

const MAX_TYPE_CHARS = 4_000

/** Type into the focused element, optionally focusing a CSS selector first. */
export async function typeText(
  text: string,
  opts: {
    signal?: AbortSignal
    selector?: string
    clear?: boolean
    pressEnter?: boolean
    tabId?: string
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => typeTextUnlocked(text, opts), opts.workspacePath)
}

async function typeTextUnlocked(
  text: string,
  opts: {
    signal?: AbortSignal
    selector?: string
    clear?: boolean
    pressEnter?: boolean
    tabId?: string
    settleMs?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const value = String(text ?? '')
  if (value.length > MAX_TYPE_CHARS) {
    throw new Error(`text exceeds ${MAX_TYPE_CHARS} characters`)
  }

  const tab = requireTab(opts.tabId)
  activateTab(tab)
  const wc = tabContents(tab)

  let focusNote = 'active element'
  let cssForFill: string | null = null
  const selector = opts.selector?.trim()
  if (selector) {
    const hit = await resolveSelector(tab, selector)
    throwIfAborted(opts.signal)
    cssForFill = hit.css
    wc.sendInputEvent({
      type: 'mouseDown',
      x: hit.x,
      y: hit.y,
      button: 'left',
      clickCount: 1
    })
    wc.sendInputEvent({
      type: 'mouseUp',
      x: hit.x,
      y: hit.y,
      button: 'left',
      clickCount: 1
    })
    focusNote = `${hit.tag}${hit.label ? ` "${hit.label}"` : ''} (${selector})`
  } else {
    await wc.executeJavaScript(
      `(() => {
        const el = document.activeElement
        if (el && typeof el.focus === 'function') el.focus()
        return true
      })()`,
      true
    )
  }

  throwIfAborted(opts.signal)

  let path = 'insertText'
  if (cssForFill && opts.clear) {
    const filled = (await wc.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(cssForFill)})
        if (!el) return false
        const tag = el.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const proto = tag === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
          const desc = Object.getOwnPropertyDescriptor(proto, 'value')
          if (desc && desc.set) desc.set.call(el, ${JSON.stringify(value)})
          else el.value = ${JSON.stringify(value)}
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return 'value'
        }
        return false
      })()`,
      true
    )) as false | 'value'
    if (filled === 'value') {
      path = 'input.value'
    } else {
      const selectMod = process.platform === 'darwin' ? 'meta' : 'control'
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [selectMod] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [selectMod] })
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
      if (value.length > 0) wc.insertText(value)
    }
  } else {
    if (opts.clear) {
      const selectMod = process.platform === 'darwin' ? 'meta' : 'control'
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [selectMod] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [selectMod] })
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    }
    if (value.length > 0) wc.insertText(value)
  }

  if (opts.pressEnter) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await settleAfterAction(wc, opts.signal, { waitForNav: true, settleMs: opts.settleMs })
  } else {
    await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
  }

  emitCurrent()
  const clearNote = opts.clear ? ', cleared first' : ''
  const enterNote = opts.pressEnter ? ', pressed Enter' : ''
  return `Typed ${value.length} character(s) into ${focusNote}${clearNote}${enterNote} via ${path}`
}

/** Scroll the agent browser page or a target element into view / by deltas. */
export async function scrollPage(
  opts: {
    signal?: AbortSignal
    selector?: string
    deltaX?: number
    deltaY?: number
    tabId?: string
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => scrollPageUnlocked(opts), opts.workspacePath)
}

async function scrollPageUnlocked(
  opts: {
    signal?: AbortSignal
    selector?: string
    deltaX?: number
    deltaY?: number
    tabId?: string
    settleMs?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const tab = requireTab(opts.tabId)
  activateTab(tab)
  const wc = tabContents(tab)
  const selector = opts.selector?.trim()
  const dx = Number.isFinite(opts.deltaX) ? Number(opts.deltaX) : 0
  const dy = Number.isFinite(opts.deltaY) ? Number(opts.deltaY) : 0

  if (selector) {
    const hit = await resolveSelector(tab, selector)
    throwIfAborted(opts.signal)
    await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
    emitCurrent()
    return `Scrolled ${hit.tag}${hit.label ? ` "${hit.label}"` : ''} into view (${selector})`
  }

  if (dx === 0 && dy === 0) {
    throw new Error('Provide selector to scroll into view, or deltaX/deltaY to scroll the page')
  }

  await wc.executeJavaScript(
    `window.scrollBy(${dx}, ${dy}); true`,
    true
  )
  await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
  emitCurrent()
  return `Scrolled page by (${dx}, ${dy})`
}

/** Fill an input/textarea via the value setter (React-friendly) or type into contenteditable. */
export async function fillSelector(
  selector: string,
  value: string,
  opts: {
    signal?: AbortSignal
    pressEnter?: boolean
    tabId?: string
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => fillSelectorUnlocked(selector, value, opts), opts.workspacePath)
}

async function fillSelectorUnlocked(
  selector: string,
  value: string,
  opts: { signal?: AbortSignal; pressEnter?: boolean; tabId?: string; settleMs?: number } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const sel = String(selector ?? '').trim()
  if (!sel) throw new Error('selector is required')
  const text = String(value ?? '')
  if (text.length > MAX_TYPE_CHARS) {
    throw new Error(`value exceeds ${MAX_TYPE_CHARS} characters`)
  }

  const tab = requireTab(opts.tabId)
  activateTab(tab)
  const wc = tabContents(tab)

  const hit = await resolveSelector(tab, sel)
  throwIfAborted(opts.signal)

  const result = (await wc.executeJavaScript(
    `(() => {
      const el = document.querySelector(${JSON.stringify(hit.css)})
      if (!el) return { ok: false, reason: 'missing' }
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const proto = tag === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
        const desc = Object.getOwnPropertyDescriptor(proto, 'value')
        if (desc && desc.set) desc.set.call(el, ${JSON.stringify(text)})
        else el.value = ${JSON.stringify(text)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, path: 'value' }
      }
      if (el.isContentEditable) {
        el.focus()
        el.textContent = ${JSON.stringify(text)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return { ok: true, path: 'contenteditable' }
      }
      return { ok: false, reason: 'not-fillable' }
    })()`,
    true
  )) as { ok: boolean; path?: string; reason?: string }

  if (!result?.ok) {
    throw new Error(
      result?.reason === 'not-fillable'
        ? `Element is not a fillable input/textarea/contenteditable: ${sel}`
        : `Could not fill selector: ${sel}`
    )
  }

  if (opts.pressEnter) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await settleAfterAction(wc, opts.signal, { waitForNav: true, settleMs: opts.settleMs })
  } else {
    await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
  }

  emitCurrent()
  const label = hit.label ? ` "${hit.label}"` : ''
  return `Filled ${hit.tag}${label} with ${text.length} character(s) via ${result.path} (${sel})`
}

export function focusAgentBrowser(): boolean {
  if (!activeTabId) return false
  const tab = tabs.get(activeTabId)
  if (!tab || isTabDestroyed(tab)) return false
  activateTab(tab)
  return true
}

export function closeAgentBrowser(): void {
  for (const tab of [...tabs.values()]) {
    destroyTab(tab)
  }
  tabs.clear()
  activeTabId = null
  // Keep embedBounds — the chat panel is always visible and will host the next tab.
  pushState({
    open: false,
    url: '',
    title: '',
    navigating: false,
    tabs: [],
    canGoBack: false,
    canGoForward: false
  })
}

/** Close browser tabs owned by a workspace (e.g. when the workspace is removed). */
export function disposeAgentBrowserForWorkspace(workspacePath: string): number {
  let closed = 0
  for (const tab of [...tabs.values()]) {
    if (!tab.workspacePath || !workspacePathsEqual(tab.workspacePath, workspacePath)) continue
    destroyTab(tab)
    closed += 1
  }
  if (activeTabId && !tabs.has(activeTabId)) {
    activeTabId = tabs.keys().next().value ?? null
  }
  emitCurrent({ navigating: false })
  return closed
}

export type BrowserClearKind = 'history' | 'cookies' | 'cache' | 'all'

function clearTabNavigationHistory(): void {
  for (const tab of tabs.values()) {
    if (isTabDestroyed(tab)) continue
    const wc = tab.view.webContents
    try {
      if (wc.navigationHistory && typeof wc.navigationHistory.clear === 'function') {
        wc.navigationHistory.clear()
      } else if (typeof wc.clearHistory === 'function') {
        wc.clearHistory()
      }
    } catch {
      /* ignore */
    }
  }
  emitCurrent()
}

/** Clear storage/cache for the agent-browser partition only. */
export async function clearAgentBrowserData(
  kind: BrowserClearKind
): Promise<{ cleared: BrowserClearKind }> {
  const ses = session.fromPartition(PARTITION)
  if (kind === 'history' || kind === 'all') {
    // Reset in-tab navigation stacks without destroying live tabs.
    // App-level Recents are cleared in the renderer.
    clearTabNavigationHistory()
  }
  if (kind === 'cookies') {
    await ses.clearStorageData({ storages: ['cookies'] })
  } else if (kind === 'all') {
    await ses.clearStorageData({
      storages: [
        'cookies',
        'localstorage',
        'indexdb',
        'shadercache',
        'serviceworkers',
        'cachestorage',
        'filesystem'
      ]
    })
  }
  if (kind === 'cache' || kind === 'all') {
    await ses.clearCache()
  }
  return { cleared: kind }
}

/** Capture the active page to `{runDir}/browser/snapshot.jpg`. */
export async function takeBrowserScreenshot(opts: {
  runDir: string
  tabId?: string
  workspacePath?: string
}): Promise<{ path: string }> {
  return withBrowserLock(async () => {
    const tab = requireTab(opts.tabId)
    activateTab(tab)
    const wc = tabContents(tab)
    let image = await wc.capturePage()
    const size = image.getSize()
    if (size.width > PREVIEW_MAX_WIDTH) {
      image = image.resize({ width: PREVIEW_MAX_WIDTH, quality: 'better' })
    }
    const jpeg = image.toJPEG(SNAPSHOT_JPEG_QUALITY)
    const dir = join(opts.runDir, 'browser')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'snapshot.jpg')
    writeFileSync(path, jpeg)
    return { path }
  }, opts.workspacePath)
}

export function getAgentBrowserState(): AgentBrowserState {
  return lastState
}

export function selectBrowserTab(tabId: string): boolean {
  const tab = tabs.get(tabId)
  if (!tab || isTabDestroyed(tab)) return false
  activateTab(tab)
  emitCurrent()
  return true
}

export async function browserGoBack(): Promise<boolean> {
  try {
    await goBack()
    return true
  } catch {
    return false
  }
}

export async function browserGoForward(): Promise<boolean> {
  try {
    await goForward()
    return true
  } catch {
    return false
  }
}

/** Test helper — reset singleton without touching Electron windows. */
export function resetAgentBrowserForTests(): void {
  tabs.clear()
  activeTabId = null
  embedBounds = null
  lastState = {
    open: false,
    url: '',
    title: '',
    navigating: false,
    tabs: [],
    canGoBack: false,
    canGoForward: false
  }
  browserOpChains.clear()
  tabSeq = 0
}

function clampWaitTimeout(timeoutMs?: number): number {
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(100, timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS))
}

export async function manageTabs(
  action: 'list' | 'open' | 'close' | 'select',
  opts: { tabId?: string; url?: string; signal?: AbortSignal; workspacePath?: string } = {}
): Promise<string> {
  return withBrowserLock(() => manageTabsUnlocked(action, opts), opts.workspacePath)
}

async function manageTabsUnlocked(
  action: 'list' | 'open' | 'close' | 'select',
  opts: { tabId?: string; url?: string; signal?: AbortSignal; workspacePath?: string } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  if (action === 'list') {
    const rows = listTabStates()
    if (rows.length === 0) return 'No browser tabs open.'
    return rows
      .map((t) => `${t.active ? '*' : ' '} ${t.id}  ${t.title || '(untitled)'}  ${t.url || '(blank)'}`)
      .join('\n')
  }
  if (action === 'open') {
    const tab = createTab(opts.workspacePath)
    activeTabId = tab.id
    if (opts.url?.trim()) {
      return await navigateUrlUnlocked(opts.url.trim(), {
        signal: opts.signal,
        tabId: tab.id,
        workspacePath: opts.workspacePath
      })
    }
    activateTab(tab)
    emitCurrent()
    return `Opened tab ${tab.id} (blank)`
  }
  if (action === 'select') {
    const id = opts.tabId?.trim()
    if (!id) throw new Error('tab_id is required for browser_tabs select')
    const tab = requireTab(id)
    activateTab(tab)
    emitCurrent()
    return `Selected tab ${tab.id}: ${tabContents(tab).getURL() || '(blank)'}`
  }
  // close
  const id = opts.tabId?.trim() || activeTabId
  if (!id) throw new Error('No tab to close')
  const tab = tabs.get(id)
  if (!tab || isTabDestroyed(tab)) throw new Error(`Unknown browser tab_id: ${id}`)
  destroyTab(tab)
  emitCurrent()
  return `Closed tab ${id}`
}

export async function goBack(
  opts: { tabId?: string; signal?: AbortSignal; workspacePath?: string } = {}
): Promise<string> {
  return withBrowserLock(() => goHistoryUnlocked('back', opts), opts.workspacePath)
}

export async function goForward(
  opts: { tabId?: string; signal?: AbortSignal; workspacePath?: string } = {}
): Promise<string> {
  return withBrowserLock(() => goHistoryUnlocked('forward', opts), opts.workspacePath)
}

async function goHistoryUnlocked(
  dir: 'back' | 'forward',
  opts: { tabId?: string; signal?: AbortSignal }
): Promise<string> {
  throwIfAborted(opts.signal)
  const tab = requireTab(opts.tabId)
  activateTab(tab)
  const wc = tabContents(tab)
  const flags = navFlags(wc)
  if (dir === 'back' && !flags.canGoBack) throw new Error('No back history for this tab')
  if (dir === 'forward' && !flags.canGoForward) throw new Error('No forward history for this tab')

  emitCurrent({ navigating: true })
  const { arm, checkIdle, done } = await waitForLoad(wc, opts.signal, DEFAULT_NAV_TIMEOUT_MS)
  arm()
  if (dir === 'back') wc.goBack()
  else wc.goForward()
  checkIdle()
  try {
    await done
  } catch (err) {
    emitCurrent({ navigating: false })
    throw err
  }

  const finalUrl = wc.getURL()
  try {
    await assertPublicUrl(finalUrl)
  } catch (err) {
    void wc.loadURL('about:blank')
    emitCurrent({ navigating: false })
    throw err
  }
  tab.lastRefs = new Map()
  emitCurrent({ navigating: false })
  return `Went ${dir} to ${finalUrl}`
}

export async function waitForSelector(
  selector: string,
  opts: { tabId?: string; timeoutMs?: number; signal?: AbortSignal; workspacePath?: string } = {}
): Promise<string> {
  return withBrowserLock(() => waitForSelectorUnlocked(selector, opts), opts.workspacePath)
}

async function waitForSelectorUnlocked(
  selector: string,
  opts: { tabId?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const sel = String(selector ?? '').trim()
  if (!sel) throw new Error('selector is required')
  const tab = requireTab(opts.tabId)
  activateTab(tab)
  const timeoutMs = clampWaitTimeout(opts.timeoutMs)
  const deadline = Date.now() + timeoutMs
  let lastErr = 'not found'
  while (Date.now() < deadline) {
    throwIfAborted(opts.signal)
    try {
      const hit = await resolveSelector(tab, sel)
      return `Found ${hit.tag}${hit.label ? ` "${hit.label}"` : ''} via ${sel}`
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for selector: ${sel} (${lastErr})`)
}

export async function waitForUrl(
  match: string,
  opts: {
    tabId?: string
    timeoutMs?: number
    signal?: AbortSignal
    regex?: boolean
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => waitForUrlUnlocked(match, opts), opts.workspacePath)
}

async function waitForUrlUnlocked(
  match: string,
  opts: { tabId?: string; timeoutMs?: number; signal?: AbortSignal; regex?: boolean } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const needle = String(match ?? '')
  if (!needle) throw new Error('match is required')
  const tab = requireTab(opts.tabId)
  activateTab(tab)
  const timeoutMs = clampWaitTimeout(opts.timeoutMs)
  const deadline = Date.now() + timeoutMs
  let re: RegExp | null = null
  if (opts.regex) {
    try {
      re = new RegExp(needle)
    } catch {
      throw new Error(`Invalid URL match regex: ${needle}`)
    }
  }
  while (Date.now() < deadline) {
    throwIfAborted(opts.signal)
    const url = tabContents(tab).getURL()
    const ok = re ? re.test(url) : url.includes(needle)
    if (ok) return `URL matched: ${url}`
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for URL matching ${opts.regex ? '/' + needle + '/' : JSON.stringify(needle)} (last: ${tabContents(tab).getURL()})`
  )
}

export async function pressKey(
  key: string,
  opts: {
    tabId?: string
    modifiers?: string[]
    signal?: AbortSignal
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => pressKeyUnlocked(key, opts), opts.workspacePath)
}

async function pressKeyUnlocked(
  key: string,
  opts: {
    tabId?: string
    modifiers?: string[]
    signal?: AbortSignal
    settleMs?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const keyCode = String(key ?? '').trim()
  if (!keyCode) throw new Error('key is required')
  const tab = requireTab(opts.tabId)
  activateTab(tab)
  const wc = tabContents(tab)
  const modifiers = (opts.modifiers ?? []).map((m) => String(m).toLowerCase()) as Array<
    'command' | 'control' | 'ctrl' | 'shift' | 'alt' | 'meta'
  >
  const normalized = modifiers.map((m) => (m === 'ctrl' ? 'control' : m === 'command' ? 'meta' : m))
  wc.sendInputEvent({
    type: 'keyDown',
    keyCode,
    modifiers: normalized as Electron.InputEvent['modifiers']
  })
  wc.sendInputEvent({
    type: 'keyUp',
    keyCode,
    modifiers: normalized as Electron.InputEvent['modifiers']
  })
  await settleAfterAction(wc, opts.signal, {
    waitForNav: keyCode === 'Return' || keyCode === 'Enter',
    settleMs: opts.settleMs
  })
  emitCurrent()
  const modNote = normalized.length ? ` with ${normalized.join('+')}` : ''
  return `Pressed ${keyCode}${modNote}`
}

export async function selectOption(
  selector: string,
  opts: {
    value?: string
    label?: string
    tabId?: string
    signal?: AbortSignal
    pressEnter?: boolean
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => selectOptionUnlocked(selector, opts), opts.workspacePath)
}

async function selectOptionUnlocked(
  selector: string,
  opts: {
    value?: string
    label?: string
    tabId?: string
    signal?: AbortSignal
    pressEnter?: boolean
    settleMs?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const sel = String(selector ?? '').trim()
  if (!sel) throw new Error('selector is required')
  const value = opts.value
  const label = opts.label
  if ((value == null || value === '') && (label == null || label === '')) {
    throw new Error('Provide value or label for browser_select_option')
  }

  const tab = requireTab(opts.tabId)
  activateTab(tab)
  const wc = tabContents(tab)
  const hit = await resolveSelector(tab, sel)
  throwIfAborted(opts.signal)

  const result = (await wc.executeJavaScript(
    `(() => {
      const el = document.querySelector(${JSON.stringify(hit.css)})
      if (!el || el.tagName !== 'SELECT') return { ok: false, reason: 'not-select' }
      const value = ${JSON.stringify(value ?? null)}
      const label = ${JSON.stringify(label ?? null)}
      let opt = null
      if (value != null) {
        opt = Array.from(el.options).find((o) => o.value === value) || null
      }
      if (!opt && label != null) {
        opt = Array.from(el.options).find((o) => String(o.textContent || '').trim() === label) || null
      }
      if (!opt) return { ok: false, reason: 'no-option' }
      el.value = opt.value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: opt.value, label: String(opt.textContent || '').trim() }
    })()`,
    true
  )) as { ok: boolean; reason?: string; value?: string; label?: string }

  if (!result?.ok) {
    throw new Error(
      result?.reason === 'not-select'
        ? `Element is not a <select>: ${sel}`
        : `No matching option for selector: ${sel}`
    )
  }

  if (opts.pressEnter) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await settleAfterAction(wc, opts.signal, { waitForNav: true, settleMs: opts.settleMs })
  } else {
    await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
  }

  emitCurrent()
  return `Selected option "${result.label}" (value=${result.value}) on ${sel}`
}
