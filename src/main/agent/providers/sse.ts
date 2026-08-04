/** Iterate SSE `data:` payloads from a fetch Response body. */
import { isAbortError } from '../../../shared/errors'
import { isRetriableNetworkError, RetriableStreamError } from './fetchWithRetry'
import { logProviderFailure } from './log'

/**
 * Abort if the body delivers no bytes for this long.
 * Sized for slow reasoning TTFT (e.g. OpenRouter Luna Pro multi-minute silence)
 * while still cutting truly hung sockets. OpenRouter `: keepalive` comments reset
 * the timer because they arrive as bytes on the reader.
 */
export const STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000

export class StreamIdleTimeoutError extends Error {
  readonly idleMs: number

  constructor(idleMs: number) {
    super(
      `Provider stream idle for ${Math.round(idleMs / 1000)}s with no data (including keep-alives)`
    )
    this.name = 'StreamIdleTimeoutError'
    this.idleMs = idleMs
  }
}

export function isStreamIdleTimeoutError(err: unknown): err is StreamIdleTimeoutError {
  return err instanceof StreamIdleTimeoutError
}

export type IterateSseOptions = {
  /**
   * Idle watchdog threshold. Default {@link STREAM_IDLE_TIMEOUT_MS}.
   * Pass `0` to disable (tests / explicit opt-out only).
   */
  idleTimeoutMs?: number
}

/**
 * Race one body read against the idle deadline. Any resolved chunk (including
 * SSE comment lines) resets the caller’s next deadline.
 */
function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  if (idleTimeoutMs <= 0) {
    if (signal.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    }
    return reader.read()
  }

  return new Promise((resolve, reject) => {
    let settled = false

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      fn()
    }

    const timer = setTimeout(() => {
      settle(() => {
        void reader.cancel().catch(() => undefined)
        logProviderFailure('sse', 'timeout', {
          message: `idle ${Math.round(idleTimeoutMs / 1000)}s`
        })
        reject(new StreamIdleTimeoutError(idleTimeoutMs))
      })
    }, idleTimeoutMs)

    const onAbort = (): void => {
      settle(() => {
        void reader.cancel().catch(() => undefined)
        reject(new DOMException('Aborted', 'AbortError'))
      })
    }

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })

    reader.read().then(
      (result) => settle(() => resolve(result)),
      (err) => settle(() => reject(err))
    )
  })
}

export async function* iterateSseData(
  res: Response,
  signal: AbortSignal,
  opts?: IterateSseOptions
): AsyncGenerator<string> {
  if (!res.body) {
    logProviderFailure('sse', 'stream', {})
    throw new Error('No response body')
  }
  const idleTimeoutMs = opts?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []

  const flush = (): string | null => {
    if (dataLines.length === 0) return null
    const data = dataLines.join('\n')
    dataLines = []
    return data
  }

  let finished = false
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined)
        throw new DOMException('Aborted', 'AbortError')
      }
      let readResult: Awaited<ReturnType<typeof reader.read>>
      try {
        readResult = await readWithIdleTimeout(reader, idleTimeoutMs, signal)
      } catch (readErr) {
        if (isAbortError(readErr) || isStreamIdleTimeoutError(readErr)) throw readErr
        if (isRetriableNetworkError(readErr)) {
          throw new RetriableStreamError(formatStreamReadError(readErr), readErr)
        }
        throw readErr
      }
      const { done, value } = readResult
      if (done) {
        finished = true
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''

      for (const raw of parts) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (line === '') {
          const data = flush()
          if (data === null) continue
          if (data === '[DONE]') return
          yield data
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('data:')) {
          const v = line.slice(5)
          dataLines.push(v.startsWith(' ') ? v.slice(1) : v)
        }
      }
    }

    if (buffer.length) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
      if (line.startsWith('data:')) {
        const v = line.slice(5)
        dataLines.push(v.startsWith(' ') ? v.slice(1) : v)
      }
    }

    const data = flush()
    if (data !== null && data !== '[DONE]') yield data
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined)
    }
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

function formatStreamReadError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Counts frames a stream had to discard. Silently swallowing them turns a
 * corrupted stream into a plausible-looking short answer, so callers surface
 * the count once the stream ends.
 */
export type SseDropCounter = { dropped: number }

export async function* iterateSseJson(
  res: Response,
  signal: AbortSignal,
  drops?: SseDropCounter,
  opts?: IterateSseOptions
): AsyncGenerator<Record<string, unknown>> {
  for await (const data of iterateSseData(res, signal, opts)) {
    if (!data.trim()) continue
    try {
      yield JSON.parse(data) as Record<string, unknown>
    } catch {
      if (drops) drops.dropped++
      logProviderFailure('sse', 'parse', { bytes: data.length })
    }
  }
}
