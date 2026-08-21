import { isAbortError } from '../../shared/errors'
import {
  assertCircuitClosed,
  isCircuitOpenError,
  recordCircuitFailure,
  recordCircuitSuccess,
  releaseCircuitProbe
} from './circuitBreaker'
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

/** Connection retries live in fetchWithRetry; do not multiply them at the stream layer. */
export function shouldRetryStreamErrorChunk(
  errorCode: string,
  message: string,
  attempt: number
): boolean {
  if (errorCode === 'CIRCUIT_OPEN' || errorCode === 'PROVIDER_NETWORK') return false
  return shouldRetryProviderStreamError(message, attempt)
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

/** `terminal` = attempt ended the whole run (hard error / idle timeout); caller should stop. */
export type StreamAttemptOutcome = 'complete' | 'retry' | 'terminal'

export type StreamAttemptDecision =
  | { action: 'complete' }
  | { action: 'terminal' }
  | { action: 'retry' }
  | { action: 'exhausted'; err?: unknown }
  | { action: 'throw'; err: unknown }

/**
 * Shared attempt classification for Promise + generator stream retry drivers.
 * When `exhaustedOnLastRetriableThrow` is true (agent loop), a retriable throw on
 * the final attempt becomes `exhausted` instead of rethrowing.
 */
export function decideStreamAttemptResult(
  result: { ok: true; outcome: StreamAttemptOutcome } | { ok: false; err: unknown },
  attempt: number,
  opts?: { exhaustedOnLastRetriableThrow?: boolean }
): StreamAttemptDecision {
  if (result.ok) {
    if (result.outcome === 'complete') return { action: 'complete' }
    if (result.outcome === 'terminal') return { action: 'terminal' }
    if (attempt < MAX_STREAM_ATTEMPTS) return { action: 'retry' }
    return { action: 'exhausted' }
  }

  const err = result.err
  if (isAbortError(err)) return { action: 'throw', err }
  if (isCircuitOpenError(err)) return { action: 'exhausted', err }
  if (shouldRetryThrownStreamError(err, attempt)) return { action: 'retry' }
  if (opts?.exhaustedOnLastRetriableThrow && isRetriableStreamFailure(err)) {
    return { action: 'exhausted', err }
  }
  return { action: 'throw', err }
}

export type StreamRetryGenResult =
  | { status: 'complete' }
  | { status: 'terminal' }
  | { status: 'exhausted'; err?: unknown }

/**
 * Run a provider stream attempt with shared retry/backoff policy.
 * `runAttempt` returns `retry` for retriable inline stream errors; thrown
 * retriable failures are retried automatically. AbortError is rethrown.
 */
export async function runWithStreamRetry(options: {
  signal?: AbortSignal
  circuitKey?: string
  onAttemptStart: (attempt: number) => void
  onRetriableFailure?: (err: unknown, attempt: number) => void
  runAttempt: (attempt: number) => Promise<StreamAttemptOutcome>
}): Promise<void> {
  if (options.circuitKey) assertCircuitClosed(options.circuitKey)
  for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt++) {
    options.onAttemptStart(attempt)
    let decision: StreamAttemptDecision
    try {
      const outcome = await options.runAttempt(attempt)
      decision = decideStreamAttemptResult({ ok: true, outcome }, attempt)
    } catch (err) {
      decision = decideStreamAttemptResult({ ok: false, err }, attempt)
      if (decision.action === 'retry') {
        options.onRetriableFailure?.(err, attempt)
      }
    }

    if (decision.action === 'complete') {
      if (options.circuitKey) recordCircuitSuccess(options.circuitKey)
      return
    }
    if (decision.action === 'terminal') {
      if (options.circuitKey) releaseCircuitProbe(options.circuitKey)
      return
    }
    if (decision.action === 'throw') {
      if (options.circuitKey && isAbortError(decision.err)) {
        releaseCircuitProbe(options.circuitKey)
      }
      throw decision.err
    }
    if (decision.action === 'exhausted') {
      if (options.circuitKey) recordCircuitFailure(options.circuitKey)
      if (isCircuitOpenError(decision.err)) throw decision.err
      throw new RetriableStreamError('Stream retries exhausted')
    }
    // retry
    if (attempt < MAX_STREAM_ATTEMPTS) {
      try {
        await sleepStreamRetryBackoff(options.signal, attempt)
      } catch (err) {
        if (options.circuitKey && isAbortError(err)) {
          releaseCircuitProbe(options.circuitKey)
        }
        throw err
      }
      continue
    }
    if (options.circuitKey) recordCircuitFailure(options.circuitKey)
    throw new RetriableStreamError('Stream retries exhausted')
  }
}

/**
 * Generator-aware stream retry driver for the agent loop.
 * Yields events from attempt start, runAttempt, and waitBeforeRetry.
 * Retriable thrown failures invoke onRetriableFailure then waitBeforeRetry.
 */
export async function* runWithStreamRetryGen<TEvent>(options: {
  circuitKey?: string
  onAttemptStart: (attempt: number) => AsyncGenerator<TEvent, void> | Generator<TEvent, void> | void
  waitBeforeRetry: (attempt: number) => AsyncGenerator<TEvent, void> | Generator<TEvent, void>
  onRetriableFailure?: (err: unknown, attempt: number) => void
  runAttempt: (attempt: number) => AsyncGenerator<TEvent, StreamAttemptOutcome>
}): AsyncGenerator<TEvent, StreamRetryGenResult> {
  if (options.circuitKey) {
    try {
      assertCircuitClosed(options.circuitKey)
    } catch (err) {
      if (isCircuitOpenError(err)) return { status: 'exhausted', err }
      throw err
    }
  }
  for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt++) {
    const started = options.onAttemptStart(attempt)
    if (started) yield* started

    let decision: StreamAttemptDecision
    try {
      const outcome = yield* options.runAttempt(attempt)
      decision = decideStreamAttemptResult({ ok: true, outcome }, attempt, {
        exhaustedOnLastRetriableThrow: true
      })
    } catch (err) {
      decision = decideStreamAttemptResult({ ok: false, err }, attempt, {
        exhaustedOnLastRetriableThrow: true
      })
      if (decision.action === 'retry') {
        options.onRetriableFailure?.(err, attempt)
      }
    }

    if (decision.action === 'complete') {
      if (options.circuitKey) recordCircuitSuccess(options.circuitKey)
      return { status: 'complete' }
    }
    if (decision.action === 'terminal') {
      if (options.circuitKey) releaseCircuitProbe(options.circuitKey)
      return { status: 'terminal' }
    }
    if (decision.action === 'throw') {
      if (options.circuitKey && isAbortError(decision.err)) {
        releaseCircuitProbe(options.circuitKey)
      }
      throw decision.err
    }
    if (decision.action === 'exhausted') {
      if (options.circuitKey) recordCircuitFailure(options.circuitKey)
      return { status: 'exhausted', err: decision.err }
    }

    try {
      yield* options.waitBeforeRetry(attempt)
    } catch (err) {
      if (options.circuitKey && isAbortError(err)) {
        releaseCircuitProbe(options.circuitKey)
      }
      throw err
    }
  }

  if (options.circuitKey) recordCircuitFailure(options.circuitKey)
  return { status: 'exhausted' }
}
