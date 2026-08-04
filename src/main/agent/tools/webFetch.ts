import { lookup as dnsLookup } from 'dns/promises'
import { mkdirSync, writeFileSync } from 'fs'
import * as http from 'http'
import * as https from 'https'
import { isIP } from 'net'
import { dirname } from 'path'
import type { IncomingMessage, RequestOptions } from 'http'

export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024
export const WEB_FETCH_DEFAULT_TIMEOUT_MS = 20_000
export const WEB_FETCH_DEFAULT_MAX_CHARS = 40_000
export const WEB_FETCH_MAX_TIMEOUT_MS = 60_000
const MAX_BYTES = WEB_FETCH_MAX_BYTES
const DEFAULT_TIMEOUT_MS = WEB_FETCH_DEFAULT_TIMEOUT_MS
const MAX_TIMEOUT_MS = WEB_FETCH_MAX_TIMEOUT_MS
const DEFAULT_MAX_CHARS = WEB_FETCH_DEFAULT_MAX_CHARS
const MAX_REDIRECTS = 5

type LookupFn = typeof dnsLookup

let resolveHost: LookupFn = dnsLookup

/** Test helper — override DNS resolution for SSRF checks. */
export function setDnsLookupForTests(next: LookupFn): void {
  resolveHost = next
}

/** Test helper — restore default DNS resolution. */
export function resetDnsLookupForTests(): void {
  resolveHost = dnsLookup
}

/** Resolve a URL with optional allowance for local/private addresses. */
export async function assertAllowedUrl(raw: string, allowLocal = false): Promise<URL> {
  const { url } = await resolveAllowedUrl(raw, allowLocal)
  return url
}

/** Backward-compatible alias that always blocks local/private addresses. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  return assertAllowedUrl(raw, false)
}

/**
 * Resolve an http(s) URL and return the validated addresses so callers can pin
 * the TCP connect (DNS-rebinding resistant).
 *
 * @param allowLocal When `true`, loopback and private ranges (127/8, 10/8,
 *   172.16/12, 192.168/16, 169.254/16, 100.64/10, ::1, fe80::/10, fc00::/7)
 *   are allowed in addition to public addresses. Used for Ollama and other
 *   explicitly local endpoints.
 */
export async function resolveAllowedUrl(
  raw: string,
  allowLocal = false
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Not a valid URL: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported protocol ${url.protocol}; use http(s)`)
  }

  const host = stripIpv6Brackets(url.hostname).toLowerCase()
  if (isBlockedHostname(host, allowLocal)) {
    throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
  }

  const literalVersion = isIP(host)
  if (literalVersion === 4) {
    if (isBlockedAddress(host, allowLocal)) {
      throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
    }
    return { url, addresses: [host] }
  }
  if (literalVersion === 6) {
    if (isBlockedAddress(host, allowLocal)) {
      throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
    }
    return { url, addresses: [host] }
  }

  // Decimal/hex IPv4 forms that `isIP()` does not classify (e.g. 2130706433 → 127.0.0.1).
  if (isBlockedAddress(host, allowLocal)) {
    throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
  }

  const resolved = await resolveHost(host, { all: true, verbatim: true })
  if (resolved.length === 0) {
    throw new Error(`Could not resolve host: ${host}`)
  }
  const addresses: string[] = []
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address, allowLocal)) {
      throw new Error(`Refusing to fetch a private or loopback address: ${host}`)
    }
    addresses.push(entry.address)
  }

  return { url, addresses }
}

/** Backward-compatible alias that always blocks local/private addresses. */
export async function resolvePublicUrl(
  raw: string
): Promise<{ url: URL; addresses: string[] }> {
  return resolveAllowedUrl(raw, false)
}

/**
 * Sync SSRF gate for Electron navigation events (no DNS).
 * Returns true when the URL must be refused immediately.
 * Hostnames that need DNS resolution return false — callers should
 * still `assertAllowedUrl` after the load settles.
 */
export function isSyncBlockedUrl(raw: string, allowLocal = false): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return true
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return true

  const host = stripIpv6Brackets(url.hostname).toLowerCase()
  if (isBlockedHostname(host, allowLocal)) return true

  const literalVersion = isIP(host)
  if (literalVersion === 4) return isBlockedAddress(host, allowLocal)
  if (literalVersion === 6) return isBlockedAddress(host, allowLocal)
  // Alternate IPv4 encodings (decimal/hex) that `isIP()` misses.
  return isBlockedAddress(host, allowLocal)
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function isBlockedHostname(host: string, allowLocal = false): boolean {
  if (allowLocal) return false
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  )
}

function parseIpv4Parts(host: string): [number, number, number, number] | null {
  if (/^\d+$/.test(host)) {
    const value = Number(host)
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null
    return [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff
    ]
  }

  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4) return null

  const nums: number[] = []
  for (const part of parts) {
    if (!/^(0x[0-9a-f]+|\d+)$/i.test(part)) return null
    const value = Number.parseInt(part, part.startsWith('0x') ? 16 : 10)
    if (!Number.isFinite(value) || value < 0) return null
    nums.push(value)
  }

  if (nums.length === 4) {
    if (nums.some((n) => n > 255)) return null
    return nums as [number, number, number, number]
  }

  if (nums.length === 3) {
    if (nums[0] > 255 || nums[1] > 255) return null
    return [nums[0], nums[1], nums[2], 0]
  }
  if (nums.length === 2) {
    if (nums[0] > 255) return null
    return [nums[0], nums[1], 0, 0]
  }
  if (nums.length === 1) {
    const value = nums[0]
    if (value > 0xffffffff) return null
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
  }

  return null
}

function isPrivateIpv4Bytes(a: number, b: number, c: number, d: number): boolean {
  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a >= 224) return true
  return a === 0 && b === 0 && c === 0 && d === 0
}

function isPrivateIpv4(host: string): boolean {
  const parts = parseIpv4Parts(host)
  if (!parts) return false
  return isPrivateIpv4Bytes(...parts)
}

function isAllowedLocalIpv4(host: string): boolean {
  const parts = parseIpv4Parts(host)
  if (!parts) return false
  const [a, b] = parts
  if (a === 127) return true
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('fe80:')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIpv4(mapped[1])

  return false
}

function isAllowedLocalIpv6(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('fe80:')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isAllowedLocalIpv4(mapped[1])

  return false
}

function isAllowedLocalAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isAllowedLocalIpv4(address)
  if (version === 6) return isAllowedLocalIpv6(address)
  return false
}

function isBlockedAddress(address: string, allowLocal = false): boolean {
  if (allowLocal && isAllowedLocalAddress(address)) return false
  const version = isIP(address)
  if (version === 4) return isPrivateIpv4(address)
  if (version === 6) return isPrivateIpv6(address)
  // Also catch decimal / hex IPv4 encodings that `isIP()` does not classify.
  return isPrivateIpv4(address) || isPrivateIpv6(address)
}

type LookupAddress = { address: string; family: 4 | 6 }
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void

/**
 * Custom `http(s).request` lookup that pins to already-validated IPs.
 * Node 20+ Happy Eyeballs calls lookup with `{ all: true }` and expects an
 * array of `{ address, family }` — returning a bare string yields
 * `Invalid IP address: undefined`.
 */
export function createPinnedLookup(
  addresses: string[],
  allowLocal = false
): NonNullable<RequestOptions['lookup']> {
  const entries: LookupAddress[] = []
  for (const address of addresses) {
    if (isBlockedAddress(address, allowLocal)) continue
    const version = isIP(address)
    if (version !== 4 && version !== 6) continue
    entries.push({ address, family: version })
  }
  // Prefer IPv4 for the single-address path (broader compatibility).
  const preferred = entries.find((e) => e.family === 4) ?? entries[0]
  if (!preferred) {
    throw new Error('Refusing to fetch a private or loopback address')
  }

  return ((_hostname, options, callback) => {
    const opts =
      typeof options === 'object' && options !== null
        ? (options as { all?: boolean })
        : ({} as { all?: boolean })
    const cb: LookupCallback =
      typeof options === 'function' ? (options as LookupCallback) : (callback as LookupCallback)

    if (opts.all) {
      cb(null, entries)
      return
    }
    cb(null, preferred.address, preferred.family)
  }) as NonNullable<RequestOptions['lookup']>
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

/**
 * Convert HTML to a rough markdown skeleton.
 *
 * The point is to keep the structure a reader relies on — headings, links, list
 * items, code — while dropping the markup that would otherwise burn context.
 */
export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, '')

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h1[^>]*>/gi, '\n# ')
    .replace(/<h2[^>]*>/gi, '\n## ')
    .replace(/<h3[^>]*>/gi, '\n### ')
    .replace(/<h[456][^>]*>/gi, '\n#### ')
    .replace(/<code[^>]*>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const clean = label.replace(/<[^>]+>/g, '').trim()
      return clean ? `[${clean}](${href})` : href
    })
    .replace(/<[^>]+>/g, '')

  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export type WebFetchOptions = {
  timeoutMs?: number
  maxChars?: number
}

/** Fetch a public URL and return readable text, size- and time-capped. */
export async function toolWebFetch(
  rawUrl: string,
  options: WebFetchOptions = {},
  signal?: AbortSignal
): Promise<string> {
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const maxChars = Math.max(1000, options.maxChars ?? DEFAULT_MAX_CHARS)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onParentAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onParentAbort, { once: true })

  let currentUrl: URL | undefined
  try {
    currentUrl = await assertPublicUrl(String(rawUrl ?? '').trim())
    const { response: res, finalUrl } = await fetchWithValidatedRedirects(currentUrl, controller.signal)
    currentUrl = finalUrl
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${currentUrl.href}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (/^(image|audio|video|application\/(octet-stream|pdf|zip))/i.test(contentType)) {
      throw new Error(`Unsupported content type ${contentType || 'unknown'} for ${currentUrl.href}`)
    }

    const buffer = await readCapped(res, MAX_BYTES)
    const body = buffer.toString('utf8')
    const text = /html/i.test(contentType) ? htmlToMarkdown(body) : body.trim()
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text

    return [`# ${currentUrl.href}`, '', clipped].join('\n')
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(`Timed out after ${timeoutMs}ms fetching ${currentUrl?.href ?? rawUrl}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
  }
}

export async function fetchWithValidatedRedirects(
  startUrl: URL,
  signal: AbortSignal,
  headers?: Record<string, string>,
  allowLocal = false
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = startUrl

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url: validated, addresses } = await resolveAllowedUrl(currentUrl.href, allowLocal)
    const res = await publicFetchImpl(validated, addresses, signal, headers, allowLocal)

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) {
        throw new Error(`Redirect response missing Location header for ${validated.href}`)
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects while fetching ${startUrl.href}`)
      }
      currentUrl = new URL(location, validated)
      continue
    }

    return { response: res, finalUrl: validated }
  }

  throw new Error(`Too many redirects while fetching ${startUrl.href}`)
}

type PublicFetchImpl = (
  url: URL,
  addresses: string[],
  signal: AbortSignal,
  headers?: Record<string, string>,
  allowLocal?: boolean
) => Promise<Response>

/**
 * Connect using a DNS result already proven safe so a second lookup cannot
 * rebind to a private address mid-request (SNI/Host still use the hostname).
 */
async function fetchPinnedPublic(
  url: URL,
  addresses: string[],
  signal: AbortSignal,
  headers?: Record<string, string>,
  allowLocal = false
): Promise<Response> {
  let lookup: NonNullable<RequestOptions['lookup']>
  try {
    lookup = createPinnedLookup(addresses, allowLocal)
  } catch {
    throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
  }

  const defaultPort = url.protocol === 'https:' ? 443 : 80
  const port = url.port ? Number(url.port) : defaultPort
  const requestHeaders: Record<string, string> = {
    ...(headers ?? { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' }),
    host: url.host
  }

  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: requestHeaders,
    lookup
  }

  const lib = url.protocol === 'https:' ? https : http

  return await new Promise<Response>((resolve, reject) => {
    const req = lib.request(options, (incoming: IncomingMessage) => {
      const chunks: Buffer[] = []
      let total = 0
      incoming.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        total += buf.byteLength
        if (total <= MAX_BYTES) chunks.push(buf)
      })
      incoming.on('end', () => {
        const body = Buffer.concat(chunks).subarray(0, MAX_BYTES)
        const headerInit: Record<string, string> = {}
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value == null) continue
          headerInit[key] = Array.isArray(value) ? value.join(', ') : value
        }
        resolve(
          new Response(body, {
            status: incoming.statusCode ?? 0,
            statusText: incoming.statusMessage ?? '',
            headers: headerInit
          })
        )
      })
      incoming.on('error', reject)
    })

    const onAbort = (): void => {
      req.destroy(new Error('Aborted'))
    }
    if (signal.aborted) {
      onAbort()
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    req.on('close', () => {
      signal.removeEventListener('abort', onAbort)
    })
    req.end()
  })
}

let publicFetchImpl: PublicFetchImpl = fetchPinnedPublic

/** Test helper — inject fetch for redirect / network tests. */
export function setPublicFetchForTests(next: PublicFetchImpl | null): void {
  publicFetchImpl = next ?? fetchPinnedPublic
}

/** Stop reading once the cap is hit rather than buffering an unbounded body. */
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0

  try {
    while (total < cap) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  return Buffer.concat(chunks).subarray(0, cap)
}

/** Shared by web_search — public SSRF-safe fetch with redirect validation. */
export async function fetchPublicResponse(
  startUrl: URL,
  signal: AbortSignal,
  headers?: Record<string, string>
): Promise<{ response: Response; finalUrl: URL; body: Buffer }> {
  const { response, finalUrl } = await fetchWithValidatedRedirects(startUrl, signal, headers)
  const body = await readCapped(response, MAX_BYTES)
  return { response, finalUrl, body }
}

/**
 * Download a public URL to disk with DNS pinning and validated redirects.
 * Uses a higher byte cap than web_fetch (marketplace packages, etc.).
 */
export async function downloadPublicUrlToFile(
  rawUrl: string,
  destPath: string,
  signal?: AbortSignal,
  maxBytes = 100 * 1024 * 1024
): Promise<void> {
  const abortSignal = signal ?? AbortSignal.timeout(60_000)
  let currentUrl = await assertPublicUrl(String(rawUrl ?? '').trim())

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url: validated, addresses } = await resolvePublicUrl(currentUrl.href)
    const hopResult = await downloadPinnedHop(validated, addresses, abortSignal, maxBytes)

    if (hopResult.kind === 'redirect') {
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects while downloading ${rawUrl}`)
      }
      currentUrl = new URL(hopResult.location, validated)
      continue
    }

    mkdirSync(dirname(destPath), { recursive: true })
    writeFileSync(destPath, hopResult.body)
    return
  }

  throw new Error(`Too many redirects while downloading ${rawUrl}`)
}

type DownloadHopResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'body'; body: Buffer }

/** One DNS-pinned GET; either returns a redirect Location or the response body. */
function downloadPinnedHop(
  url: URL,
  addresses: string[],
  signal: AbortSignal,
  maxBytes: number
): Promise<DownloadHopResult> {
  let lookup: NonNullable<RequestOptions['lookup']>
  try {
    lookup = createPinnedLookup(addresses)
  } catch {
    return Promise.reject(
      new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
    )
  }
  const defaultPort = url.protocol === 'https:' ? 443 : 80
  const port = url.port ? Number(url.port) : defaultPort
  const lib = url.protocol === 'https:' ? https : http

  return new Promise<DownloadHopResult>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.host, accept: '*/*' },
        lookup
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0
        if (status >= 300 && status < 400) {
          const location = incoming.headers.location
          incoming.resume()
          if (!location) {
            reject(new Error(`Redirect response missing Location header for ${url.href}`))
            return
          }
          resolve({ kind: 'redirect', location: Array.isArray(location) ? location[0] : location })
          return
        }
        if (status < 200 || status >= 300) {
          incoming.resume()
          reject(new Error(`Download failed: HTTP ${status}`))
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        incoming.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          total += buf.byteLength
          if (total > maxBytes) {
            req.destroy()
            reject(new Error(`Download exceeded ${maxBytes} bytes`))
            return
          }
          chunks.push(buf)
        })
        incoming.on('end', () => resolve({ kind: 'body', body: Buffer.concat(chunks) }))
        incoming.on('error', reject)
      }
    )
    const onAbort = (): void => {
      req.destroy(new Error('Aborted'))
    }
    if (signal.aborted) {
      onAbort()
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    req.on('close', () => signal.removeEventListener('abort', onAbort))
    req.end()
  })
}
