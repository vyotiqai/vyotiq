/** Snapshot interactive-element refs for browser_click / browser_type. */

export type BrowserElementRef = {
  id: string
  selector: string
  tag: string
  role: string
  name: string
}

const REF_RE = /^@?(e\d+)$/i

/** Parse `@e12` / `e12` snapshot refs; otherwise treat as a CSS selector. */
export function parseBrowserTarget(raw: string): { kind: 'ref'; id: string } | { kind: 'css'; selector: string } {
  const trimmed = raw.trim()
  const m = REF_RE.exec(trimmed)
  if (m) return { kind: 'ref', id: m[1]!.toLowerCase() }
  return { kind: 'css', selector: trimmed }
}

export function formatInteractiveRefs(refs: BrowserElementRef[]): string {
  if (refs.length === 0) return '(no interactive elements found)'
  return refs
    .map((r) => {
      const name = r.name ? JSON.stringify(r.name) : '""'
      return `- @${r.id} ${r.role || r.tag.toLowerCase()} ${name} css=${JSON.stringify(r.selector)}`
    })
    .join('\n')
}
