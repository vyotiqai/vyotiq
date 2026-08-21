import { isAbortError } from '../../shared/errors'
import { isRetriableNetworkError } from './providers/fetchWithRetry'

const DEFAULT_PROBE_URL = 'https://1.1.1.1/cdn-cgi/trace'
const PROBE_TIMEOUT_MS = 5000
const OFFLINE_POLL_MS = 2000
export const MAX_OFFLINE_WAIT_MS = 60_000
const EXTENDED_OFFLINE_WAIT_MS = 900_000

export type OfflineWaitMode = 'default' | 'extended' | 'wait_forever'

/** Resolve offline wait budget from settings (autonomous gates wait_forever). */
export function resolveOfflineWaitMs(settings: {
  offlineWaitMode?: OfflineWaitMode
  autonomousMode?: boolean
}): number {
  const mode = settings.offlineWaitMode ?? 'default'
  if (mode === 'extended') return EXTENDED_OFFLINE_WAIT_MS
  if (mode === 'wait_forever') {
    return settings.autonomousMode === true
      ? Number.POSITIVE_INFINITY
      : EXTENDED_OFFLINE_WAIT_MS
  }
  return MAX_OFFLINE_WAIT_MS
}

function probeTimeoutSignal(parent?: AbortSignal): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
    if (!parent) return timeout
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([parent, timeout])
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  parent?.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
      controller.abort()
    },
    { once: true }
  )
  return controller.signal
}

/** Lightweight connectivity probe — does not call the LLM provider. */
export async function probeNetworkOnline(signal?: AbortSignal): Promise<boolean> {
  if (process.env.VITEST === 'true') return true
  try {
    const res = await fetch(DEFAULT_PROBE_URL, {
      method: 'GET',
      signal: probeTimeoutSignal(signal)
    })
    return res.ok
  } catch (err) {
    if (isAbortError(err)) throw err
    return false
  }
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (process.env.VITEST === 'true') {
    if (signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    }
    return Promise.resolve()
  }
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    return Promise.reject(err)
  }
  return new Promise((resolve, reject) => {
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

export type NetworkWaitCallback = (retryInMs: number) => void | Promise<void>

/**
 * Yields `retryInMs` before each offline poll sleep so callers (e.g. the agent
 * loop generator) can surface `network_wait` while still offline.
 */
export async function* iterateNetworkWait(options: {
  signal?: AbortSignal
  maxWaitMs?: number
}): AsyncGenerator<number, void, unknown> {
  const maxWaitMs = options.maxWaitMs ?? MAX_OFFLINE_WAIT_MS
  let waited = 0

  while (waited < maxWaitMs) {
    if (options.signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
    if (await probeNetworkOnline(options.signal)) return

    const retryInMs = Math.min(OFFLINE_POLL_MS, maxWaitMs - waited)
    if (retryInMs <= 0) break
    yield retryInMs
    await sleepMs(retryInMs, options.signal)
    waited += retryInMs
  }
}

/** True when an error looks like a transient network failure. */
export function isNetworkFailureCode(code: string | undefined): boolean {
  return code === 'PROVIDER_NETWORK' || code === 'PROVIDER_STREAM'
}

/** Re-export for tool-level retries (webFetch). */
export function isRetriableToolNetworkError(err: unknown): boolean {
  return isRetriableNetworkError(err)
}
