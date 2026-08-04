import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type BrowserRef = {
  id: string
  role: string
  name: string
  css: string
}

export type BrowserSnapshotParsed = {
  url: string
  title: string
  tabId: string
  viewport: string
  refs: BrowserRef[]
  body: string
  screenshotNote: string
  message: string
}

export type BrowserTabRow = {
  id: string
  title: string
  url: string
}

export type BrowserTabsParsed = {
  action: string
  tabs: BrowserTabRow[]
  message: string
}

export type BrowserActionParsed = {
  target: string
  tabId: string
  message: string
  failed: boolean
}

function headerValue(content: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'im')
  const m = re.exec(content)
  return m?.[1]?.trim() || ''
}

/** Parse browser_snapshot content from agentBrowser.takeSnapshot. */
export function parseBrowserSnapshotData(tool: UiToolRow): BrowserSnapshotParsed {
  const content = tool.content ?? ''
  if (!content.trim()) {
    return {
      url: '',
      title: '',
      tabId: '',
      viewport: '',
      refs: [],
      body: '',
      screenshotNote: '',
      message: ''
    }
  }

  const url = headerValue(content, 'URL')
  const title = headerValue(content, 'Title')
  const tabId = headerValue(content, 'tab_id')
  const viewport = headerValue(content, 'Viewport')

  const screenshotMatch = content.match(/\[Screenshot saved[^\]]*\]/i)
  const screenshotNote = screenshotMatch?.[0] ?? ''

  const refs: BrowserRef[] = []
  const refRe =
    /^-\s+@(e\d+)\s+(\S+)\s+("(?:\\.|[^"\\])*"|""|\S+)\s+css=("(?:\\.|[^"\\])*"|""|\S+)\s*$/gm
  let m: RegExpExecArray | null
  while ((m = refRe.exec(content)) !== null) {
    let name = m[3] ?? ''
    let css = m[4] ?? ''
    try {
      if (name.startsWith('"')) name = JSON.parse(name) as string
    } catch {
      name = name.replace(/^"|"$/g, '')
    }
    try {
      if (css.startsWith('"')) css = JSON.parse(css) as string
    } catch {
      css = css.replace(/^"|"$/g, '')
    }
    refs.push({ id: m[1]!, role: m[2]!, name, css })
  }

  let body = ''
  const interactiveIdx = content.search(/^Interactive elements/im)
  if (interactiveIdx >= 0) {
    const afterInteractive = content.slice(interactiveIdx)
    const blankAfterRefs = afterInteractive.search(/\n\n/)
    if (blankAfterRefs >= 0) {
      body = afterInteractive
        .slice(blankAfterRefs + 2)
        .replace(/\n?\[Screenshot saved[^\]]*\]\s*$/i, '')
        .trim()
    }
  }

  return {
    url,
    title: title === '(none)' ? '' : title,
    tabId,
    viewport: viewport === '(unknown)' ? '' : viewport,
    refs,
    body,
    screenshotNote,
    message: refs.length === 0 && !body ? content.trim() : ''
  }
}

/** Parse browser_tabs list / status content. */
export function parseBrowserTabsData(tool: UiToolRow): BrowserTabsParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const action = typeof args?.action === 'string' ? args.action : 'list'
  const content = (tool.content ?? '').trim()
  const tabs: BrowserTabRow[] = []

  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^[*\s]\s+(\S+)\s{2,}(.+?)\s{2,}(\S.*)$/)
    if (!m) continue
    tabs.push({ id: m[1]!, title: m[2]!.trim(), url: m[3]!.trim() })
  }

  return {
    action,
    tabs,
    message: tabs.length === 0 ? content : ''
  }
}

/** Parse short browser action tools (navigate, click, type, …). */
export function parseBrowserActionData(tool: UiToolRow): BrowserActionParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const message = (tool.content ?? '').trim()
  let target = ''
  if (typeof args?.url === 'string' && args.url.trim()) target = args.url.trim()
  else if (typeof args?.selector === 'string' && args.selector.trim()) target = args.selector.trim()
  else if (typeof args?.ref === 'string' && args.ref.trim()) target = args.ref.trim()
  else if (typeof args?.key === 'string' && args.key.trim()) target = args.key.trim()
  else if (typeof args?.text === 'string' && args.text.trim()) {
    target = args.text.trim().slice(0, 48)
  } else if (tool.summary?.trim()) {
    target = tool.summary.trim()
  }
  const tabFromArgs = typeof args?.tab_id === 'string' ? args.tab_id.trim() : ''
  const tabFromContent = /^tab_id:\s*(\S+)/im.exec(message)?.[1] ?? ''
  const failed =
    tool.status === 'fail' ||
    /timed out|failed|unknown snapshot ref|not interactable|ssrf|blocked/i.test(message)
  return {
    target,
    tabId: tabFromArgs || tabFromContent,
    message,
    failed
  }
}
