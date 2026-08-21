/** SQLite primary result codes: SQLITE_BUSY=5, SQLITE_LOCKED=6. */
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

export const SQLITE_BUSY_MAX_ATTEMPTS = 4
export const SQLITE_BUSY_RETRY_BASE_MS = 40

export type SqliteBusyRetryOptions = {
  attempts?: number
  delayMs?: number
  signal?: AbortSignal
}

function sqlitePrimaryErrcode(err: object): number | null {
  const rec = err as { errcode?: unknown; code?: unknown }
  if (typeof rec.errcode === 'number' && Number.isFinite(rec.errcode)) {
    return rec.errcode & 0xff
  }
  if (typeof rec.code === 'number' && Number.isFinite(rec.code)) {
    return rec.code & 0xff
  }
  return null
}

function busyShapedText(err: unknown): string {
  if (typeof err === 'string') return err
  if (err == null || typeof err !== 'object') return String(err)
  const rec = err as { code?: unknown; errstr?: unknown; message?: unknown }
  const parts: string[] = []
  if (typeof rec.code === 'string') parts.push(rec.code)
  if (typeof rec.errstr === 'string') parts.push(rec.errstr)
  if (typeof rec.message === 'string') parts.push(rec.message)
  return parts.join(' ')
}

/** True for SQLITE_BUSY / SQLITE_LOCKED (including node:sqlite "database is locked"). */
export function isSqliteBusyError(err: unknown): boolean {
  if (err == null) return false
  if (typeof err === 'object') {
    const primary = sqlitePrimaryErrcode(err)
    if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) return true
  }
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(busyShapedText(err))
}

function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Retry `fn` a bounded number of times when SQLite reports busy/locked.
 * Non-busy errors and abort are not retried.
 */
export async function withSqliteBusyRetry<T>(
  fn: () => Promise<T>,
  opts?: SqliteBusyRetryOptions
): Promise<T> {
  const attempts = Math.max(1, opts?.attempts ?? SQLITE_BUSY_MAX_ATTEMPTS)
  const baseDelay = opts?.delayMs ?? SQLITE_BUSY_RETRY_BASE_MS
  const signal = opts?.signal
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isSqliteBusyError(err) || i === attempts - 1) throw err
      await delayMs(baseDelay * (i + 1), signal)
    }
  }
  throw lastErr
}
