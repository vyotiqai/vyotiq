import { defaultSchema } from 'rehype-sanitize'

/** Markdown body sanitization — highlighted code uses `sanitizeHighlightedHtml` instead. */
export const markdownSanitizeSchema = defaultSchema

const ALLOWED_TAGS = new Set([
  'span',
  'code',
  'pre',
  'div',
  'p',
  'br',
  'strong',
  'em',
  'a',
  'ul',
  'ol',
  'li'
])

/** Attributes Shiki / highlight markup may keep on allowed tags. */
const ALLOWED_ATTRS = new Set([
  'class',
  'style',
  'href',
  'title',
  'aria-hidden',
  'tabindex',
  'data-line',
  'data-language'
])

const SAFE_HREF = /^(https?:|mailto:|#|\/[^/])/i

export function isSafeMarkdownHref(value: string | undefined): value is string {
  if (!value) return false
  const trimmed = value.trim()
  return !trimmed.startsWith('//') && SAFE_HREF.test(trimmed)
}

/** Shiki themes only ever emit these declarations — anything else is not highlight markup. */
const ALLOWED_STYLE_PROPS = new Set([
  'color',
  'background-color',
  'font-style',
  'font-weight',
  'text-decoration'
])

/** CSS escape / payload channels never allowed inside a style value. */
const UNSAFE_STYLE_VALUE = /\\|url\s*\(|expression\s*\(|javascript:|@import|[<>]/i

/**
 * Rebuild a style attribute from an allowlist of Shiki declarations. Per-declaration
 * checks close the gaps a whole-value blocklist leaves (CSS escapes, url() trackers,
 * unknown properties like behavior/position).
 */
function sanitizeStyleValue(value: string): string | null {
  const safe: string[] = []
  for (const decl of value.split(';')) {
    const trimmed = decl.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon < 0) continue
    const prop = trimmed.slice(0, colon).trim().toLowerCase()
    const val = trimmed.slice(colon + 1).trim()
    if (!ALLOWED_STYLE_PROPS.has(prop) || !val || UNSAFE_STYLE_VALUE.test(val)) continue
    safe.push(`${prop}:${val}`)
  }
  return safe.length ? safe.join(';') : null
}

function sanitizeAttrValue(name: string, value: string): string | null {
  const lower = name.toLowerCase()
  if (lower.startsWith('on')) return null
  if (!ALLOWED_ATTRS.has(lower)) return null

  if (lower === 'href') {
    const trimmed = value.trim()
    // Reject protocol-relative //… (SAFE_HREF used to allow via leading `/`).
    if (trimmed.startsWith('//') || !SAFE_HREF.test(trimmed)) return null
    return trimmed
  }

  if (lower === 'style') {
    return sanitizeStyleValue(value)
  }

  return value
}

function sanitizeOpenTag(tag: string, attrs: string): string {
  const name = tag.toLowerCase()
  if (!ALLOWED_TAGS.has(name)) return ''

  const cleaned: string[] = []
  const attrRe =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(attrs)) !== null) {
    const attrName = match[1]!
    if (attrName === '/' || attrName === '') continue
    const raw = match[2] ?? match[3] ?? match[4] ?? ''
    const safe = sanitizeAttrValue(attrName, raw)
    if (safe === null) continue
    const escaped = safe.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    cleaned.push(`${attrName.toLowerCase()}="${escaped}"`)
  }

  return cleaned.length > 0 ? `<${name} ${cleaned.join(' ')}>` : `<${name}>`
}

/**
 * Strip disallowed tags and dangerous attributes from Shiki-highlighted HTML
 * before `dangerouslySetInnerHTML`.
 */
export function sanitizeHighlightedHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<script\b[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<style\b[^>]*\/?>/gi, '')
    .replace(/<\/([a-z0-9-]+)\s*>/gi, (full, tag: string) =>
      ALLOWED_TAGS.has(tag.toLowerCase()) ? full : ''
    )
    .replace(/<([a-z0-9-]+)([^>]*)>/gi, (_full, tag: string, attrs: string) =>
      sanitizeOpenTag(tag, attrs ?? '')
    )
}
