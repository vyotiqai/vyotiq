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
