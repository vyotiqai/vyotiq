import { assertPublicUrl, fetchPublicResponse, WEB_FETCH_DEFAULT_TIMEOUT_MS, WEB_FETCH_MAX_TIMEOUT_MS } from './webFetch'

const DDG_HTML_SEARCH = 'https://html.duckduckgo.com/html/'
const DEFAULT_MAX_RESULTS = 8
const ABS_MAX_RESULTS = 15
const USER_AGENT = 'VyotiqAgent/1.0 (+https://vyotiq.com)'

export type WebSearchOptions = {
  maxResults?: number
  timeoutMs?: number
}

export type WebSearchHit = {
  title: string
  url: string
  snippet: string
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

/** Unwrap DuckDuckGo redirect links (`/l/?uddg=...`) to the destination URL. */
export function unwrapSearchHref(href: string): string {
  try {
    const u = new URL(href, DDG_HTML_SEARCH)
    const uddg = u.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return u.href
  } catch {
    return href
  }
}

/**
 * Parse DuckDuckGo HTML search results into title/url/snippet hits.
 * Exported for unit tests with fixture HTML.
 */
export function parseDdgHtmlResults(html: string, maxResults: number): WebSearchHit[] {
  const hits: WebSearchHit[] = []
  const seen = new Set<string>()
  const blockRe =
    /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*result[^"]*"|<\/body>|$)/gi

  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockRe.exec(html)) !== null && hits.length < maxResults) {
    const block = blockMatch[1]
    const linkMatch = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
      block
    )
    if (!linkMatch) continue

    const url = unwrapSearchHref(linkMatch[1])
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)

    const title = stripTags(linkMatch[2])
    if (!title) continue

    const snippetMatch =
      /<(?:a|td)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td)>/i.exec(block)
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : ''

    hits.push({ title, url, snippet })
  }

  // Fallback: loose result__a scan when markup layout differs.
  if (hits.length === 0) {
    const looseRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m: RegExpExecArray | null
    while ((m = looseRe.exec(html)) !== null && hits.length < maxResults) {
      const url = unwrapSearchHref(m[1])
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
      seen.add(url)
      const title = stripTags(m[2])
      if (!title) continue
      hits.push({ title, url, snippet: '' })
    }
  }

  return hits
}

function formatHits(query: string, hits: WebSearchHit[]): string {
  if (hits.length === 0) {
    return [`# Web search: ${query}`, '', 'No results.'].join('\n')
  }
  const lines = [`# Web search: ${query}`, '', `Found ${hits.length} result(s):`, '']
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    lines.push(`${i + 1}. ${hit.title}`)
    lines.push(`   ${hit.url}`)
    if (hit.snippet) lines.push(`   ${hit.snippet}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** Keyless web search via DuckDuckGo HTML (SSRF-safe fetch). */
export async function toolWebSearch(
  rawQuery: string,
  options: WebSearchOptions = {},
  signal?: AbortSignal
): Promise<string> {
  const query = String(rawQuery ?? '').trim()
  if (!query) throw new Error('query is required')

  const maxResults = Math.min(
    ABS_MAX_RESULTS,
    Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS)
  )
  const timeoutMs = Math.min(
    WEB_FETCH_MAX_TIMEOUT_MS,
    Math.max(1000, options.timeoutMs ?? WEB_FETCH_DEFAULT_TIMEOUT_MS)
  )

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onParentAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onParentAbort, { once: true })

  try {
    const searchUrl = await assertPublicUrl(
      `${DDG_HTML_SEARCH}?q=${encodeURIComponent(query)}`
    )
    const { response, finalUrl, body } = await fetchPublicResponse(searchUrl, controller.signal, {
      accept: 'text/html',
      'user-agent': USER_AGENT
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${finalUrl.href}`)
    }

    const html = body.toString('utf8')
    const hits = parseDdgHtmlResults(html, maxResults)
    return formatHits(query, hits)
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(`Timed out after ${timeoutMs}ms searching for ${JSON.stringify(query)}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
  }
}
