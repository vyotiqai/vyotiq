import { isAbortError } from '../../shared/errors'
import {
  isRetriableNetworkError,
  isRetriableProviderMessage,
  RetriableStreamError
} from './providers/fetchWithRetry'

export const MAX_STREAM_ATTEMPTS = 5
export const STREAM_RETRY_BASE_MS = 1000
export const STREAM_RETRY_MAX_MS = 8000

/** @deprecated Use streamRetryBackoffMs(attempt) — kept for tests that import a scalar. */
export const STREAM_RETRY_BACKOFF_MS = STREAM_RETRY_BASE_MS

export { isRetriableNetworkError, isRetriableProviderMessage, RetriableStreamError }

export function isRetriableStreamFailure(err: unknown): boolean {
  return isRetriableNetworkError(err) || err instanceof RetriableStreamError
}

export function shouldRetryProviderStreamError(message: string, attempt: number): boolean {
  return attempt < MAX_STREAM_ATTEMPTS && isRetriableProviderMessage(message)
}

export function shouldRetryThrownStreamError(err: unknown, attempt: number): boolean {
  return !isAbortError(err) && attempt < MAX_STREAM_ATTEMPTS && isRetriableStreamFailure(err)
}

/** Full jitter over exponential backoff for attempt N (1-based). */
export function streamRetryBackoffMs(attempt: number): number {
  const capped = Math.min(
    STREAM_RETRY_MAX_MS,
    STREAM_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)
  )
  return Math.round(capped / 2 + Math.random() * (capped / 2))
}

export async function sleepStreamRetryBackoff(signal?: AbortSignal, attempt = 1): Promise<void> {
  if (process.env.VITEST === 'true') {
    if (signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
    return
  }
  const ms = streamRetryBackoffMs(attempt)
  if (signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type StreamAttemptOutcome = 'complete' | 'retry'

/**
 * Run a provider stream attempt with shared retry/backoff policy.
 * `runAttempt` returns `retry` for retriable inline stream errors; thrown
 * retriable failures are retried automatically. AbortError is rethrown.
 */
export async function runWithStreamRetry(options: {
  signal?: AbortSignal
  onAttemptStart: (attempt: number) => void
  onRetriableFailure?: (err: unknown, attempt: number) => void
  runAttempt: (attempt: number) => Promise<StreamAttemptOutcome>
}): Promise<void> {
  for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt++) {
    options.onAttemptStart(attempt)
    let retry = false
    try {
      const outcome = await options.runAttempt(attempt)
      if (outcome === 'complete') return
      retry = true
    } catch (err) {
      if (isAbortError(err)) throw err
      if (shouldRetryThrownStreamError(err, attempt)) {
        options.onRetriableFailure?.(err, attempt)
        retry = true
      } else {
        throw err
      }
    }
    if (retry && attempt < MAX_STREAM_ATTEMPTS) {
      await sleepStreamRetryBackoff(options.signal, attempt)
      continue
    }
    if (retry) {
      throw new RetriableStreamError('Stream retries exhausted')
    }
    return
  }
}
