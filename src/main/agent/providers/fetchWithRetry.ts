export class RetriableStreamError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'RetriableStreamError'
    if (cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = cause
    }
  }
}

export function isRetriableProviderMessage(message: string): boolean {
  return /other side closed|ECONNRESET|terminated|socket hang up|fetch failed/i.test(message)
}

export function isRetriableNetworkError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false
  if (err instanceof Error && err.name === 'AbortError') return false

  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'])
  let current: unknown = err
  while (current) {
    if (typeof current === 'object' && current !== null) {
      const code = (current as { code?: string }).code
      if (typeof code === 'string' && codes.has(code)) return true
      const message = (current as { message?: string }).message
      if (typeof message === 'string' && isRetriableProviderMessage(message)) return true
    }
    current =
      current instanceof Error
        ? (current as Error & { cause?: unknown }).cause
        : undefined
  }

  if (err instanceof Error && isRetriableProviderMessage(err.message)) return true
  return false
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const BASE_BACKOFF_MS = 250
const MAX_RETRY_AFTER_MS = 30_000

/** `Retry-After` is either delta-seconds or an HTTP date. Ignore anything else. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined
  const raw = header.trim()
  if (!raw) return undefined

  if (/^\d+$/.test(raw)) {
    return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS)
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS)
}

/** Full jitter over the linear backoff so concurrent runs stop retrying in lockstep. */
function backoffMs(attempt: number): number {
  const ceiling = attempt * BASE_BACKOFF_MS
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
}

/**
 * An unread body keeps the socket checked out of the connection pool, so the
 * retry opens a new connection and the old one lingers until the server times
 * it out.
 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Body already consumed or the connection is gone; nothing to release.
  }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  opts?: { maxAttempts?: number }
): Promise<Response> {
  const maxAttempts = opts?.maxAttempts ?? 3
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, init)
      if ((response.status >= 500 || response.status === 429) && attempt < maxAttempts) {
        const retryAfter = retryAfterMs(response.headers?.get('retry-after') ?? null)
        await discardBody(response)
        await delay(retryAfter ?? backoffMs(attempt), init.signal)
        if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        continue
      }
      return response
    } catch (err) {
      lastError = err
      if (init.signal?.aborted) throw err
      if (!isRetriableNetworkError(err) || attempt >= maxAttempts) throw err
      await delay(backoffMs(attempt), init.signal)
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    }
  }

  throw lastError ?? new Error('fetch failed')
}
