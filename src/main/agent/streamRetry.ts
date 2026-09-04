import { isAbortError } from '../../shared/errors'
import {
  assertCircuitClosed,
  isCircuitOpenError,
  recordCircuitFailure,
  recordCircuitSuccess,
  releaseCircuitProbe
} from './circuitBreaker'
import {
  isRetriableHttpStatus,
  isRetriableNetworkError,
  isRetriableProviderMessage,
  RetriableStreamError
} from './providers/fetchWithRetry'

export const MAX_STREAM_ATTEMPTS = 5
/**
 * Run-level retries for connect-class network failures (PROVIDER_NETWORK).
 * fetchWithRetry already burns its 5-attempt connect budget inside one stream
 * call; one extra stream attempt (with a fresh fetch budget plus a network
 * wait) lets a longer outage or a flaky tunnel recover instead of ending the
 * run. Beyond that the failure surfaces as a resumable network-interrupted stop.
 */
export const PROVIDER_NETWORK_MAX_ATTEMPTS = 2
export const STREAM_RETRY_BASE_MS = 1000
export const STREAM_RETRY_MAX_MS = 8000
/** Slower curve for provider-side wait failures (429/5xx) — they need real cool-down. */
export const STREAM_HTTP_RETRY_BASE_MS = 2000
export const STREAM_HTTP_RETRY_MAX_MS = 30_000

/** @deprecated Use streamRetryBackoffMs(attempt) — kept for tests that import a scalar. */
export const STREAM_RETRY_BACKOFF_MS = STREAM_RETRY_BASE_MS

export { isRetriableNetworkError, isRetriableProviderMessage, RetriableStreamError }

export function isRetriableStreamFailure(err: unknown): boolean {
  return isRetriableNetworkError(err) || err instanceof RetriableStreamError
}

export function shouldRetryProviderStreamError(message: string, attempt: number): boolean {
  return attempt < MAX_STREAM_ATTEMPTS && isRetriableProviderMessage(message)
}

/**
 * Messages that mark a status-less in-band stream failure as permanent (auth,
 * billing, bad request). Everything else upstream mid-stream — overloads, rate
 * limits, provider hiccups — is treated as transient.
 */
export function isPermanentInBandStreamMessage(message: string): boolean {
  return /invalid api key|invalid_api_key|authentication|unauthorized|forbidden|permission denied|insufficient (credits|balance|quota)|billing|quota exceeded|model not found|invalid request|invalid_request|does not exist|not allowed|unsupported/i.test(
    message
  )
}

/**
 * Status-aware mid-stream retry. A `PROVIDER_HTTP` failure retries only for
 * transient statuses (429/408/5xx) — auth, billing, and bad-request errors are
 * permanent and must surface to the user immediately.
 */
export function shouldRetryStreamErrorChunk(
  errorCode: string,
  message: string,
  attempt: number,
  httpStatus?: number
): boolean {
  if (errorCode === 'CIRCUIT_OPEN') return false
  if (errorCode === 'PROVIDER_NETWORK') {
    // The fetch layer already retried connect failures to exhaustion inside
    // this attempt (5 × ~30s connect budget). One deliberate stream-level
    // retry — fresh fetch budget plus the network-wait backoff — recovers a
    // longer outage without ending the run mid-task.
    return attempt < PROVIDER_NETWORK_MAX_ATTEMPTS
  }
  if (errorCode === 'PROVIDER_HTTP') {
    if (httpStatus != null) return attempt < MAX_STREAM_ATTEMPTS && isRetriableHttpStatus(httpStatus)
    // Status-less in-band stream errors (OpenRouter error frames, Anthropic
    // `event: error`, Gemini in-band errors) are upstream failures mid-stream.
    // They never matched the connect-error message regex, so a transient
    // overload after several streamed seconds ended the run. Retry them like
    // an equivalent connect-time 5xx unless the message is clearly permanent.
    return attempt < MAX_STREAM_ATTEMPTS && !isPermanentInBandStreamMessage(message)
  }
  return shouldRetryProviderStreamError(message, attempt)
}

/** True when a `PROVIDER_HTTP` failure is a transient wait (429/408/5xx), not a permanent request error. */
export function isTransientHttpFailure(errorCode: string, httpStatus?: number): boolean {
  return errorCode === 'PROVIDER_HTTP' && (httpStatus == null || isRetriableHttpStatus(httpStatus))
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

/** Slow-curve variant for transient HTTP waits: base 2s, cap 30s. */
export function streamHttpRetryBackoffMs(attempt: number): number {
  const capped = Math.min(
    STREAM_HTTP_RETRY_MAX_MS,
    STREAM_HTTP_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)
  )
  return Math.round(capped / 2 + Math.random() * (capped / 2))
}

/** Pick the backoff curve from the failure class: transient HTTP waits wait longer. */
export function streamRetryBackoffMsFor(errorCode: string, attempt: number): number {
  return errorCode === 'PROVIDER_HTTP'
    ? streamHttpRetryBackoffMs(attempt)
    : streamRetryBackoffMs(attempt)
}

export async function sleepStreamRetryBackoff(
  signal?: AbortSignal,
  attempt = 1,
  ms?: number
): Promise<void> {
  if (process.env.VITEST === 'true') {
    if (signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
    return
  }
  const wait = ms ?? streamRetryBackoffMs(attempt)
  if (signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, wait)
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
      // Any un-retried throw ends the attempt without a success/failure record.
      // Release the half-open probe regardless of error type — a leaked slot
      // keeps the breaker half-open forever (permanent CIRCUIT_OPEN).
      if (options.circuitKey) {
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
      // Any un-retried throw ends the attempt without a success/failure record.
      // Release the half-open probe regardless of error type — a leaked slot
      // keeps the breaker half-open forever (permanent CIRCUIT_OPEN).
      if (options.circuitKey) {
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
