/** Agent browser accepts any http(s) URL including localhost and private networks. */
export function normalizeBrowserUrl(raw: string): URL {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('URL is required')
  const withScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withScheme)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`)
  }
  return url
}

export const DEFAULT_SNAPSHOT_CHARS = 40_000
/** Default navigation timeout ceiling used only when the model omits timeoutMs. */
export const MAX_NAV_TIMEOUT_MS = 60_000
/** Default wait-for-* timeout used only when the model omits timeoutMs. */
export const MAX_WAIT_TIMEOUT_MS = 60_000
/** Documented default for browser_type / browser_fill; not a reject cap. */
export const MAX_TYPE_CHARS = 4_000
/** Default navigation timeout (navigate / search). */
export const DEFAULT_NAV_TIMEOUT_MS = 30_000
/** Default wait-for-* timeout (selector / url / text). */
export const DEFAULT_WAIT_TIMEOUT_MS = 15_000
/** Default post-action settle wait. */
export const SETTLE_FALLBACK_MS = 1_200
