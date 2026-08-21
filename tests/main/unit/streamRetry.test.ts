import { describe, expect, it, vi } from 'vitest'
import { RetriableStreamError } from '@main/agent/providers/fetchWithRetry'
import { CircuitOpenError, recordCircuitFailure, CIRCUIT_FAILURE_THRESHOLD } from '@main/agent/circuitBreaker'
import {
  MAX_STREAM_ATTEMPTS,
  decideStreamAttemptResult,
  runWithStreamRetry,
  runWithStreamRetryGen,
  shouldRetryProviderStreamError,
  shouldRetryStreamErrorChunk,
  shouldRetryThrownStreamError,
  sleepStreamRetryBackoff,
  streamRetryBackoffMs,
  STREAM_RETRY_BASE_MS
} from '@main/agent/streamRetry'

describe('streamRetry', () => {
  it('exports shared retry constants', () => {
    expect(MAX_STREAM_ATTEMPTS).toBe(5)
    expect(STREAM_RETRY_BASE_MS).toBe(1000)
    expect(streamRetryBackoffMs(1)).toBeGreaterThanOrEqual(500)
  })

  it('classifies retriable provider and thrown stream errors', () => {
    expect(shouldRetryProviderStreamError('fetch failed: other side closed', 1)).toBe(true)
    expect(shouldRetryProviderStreamError('fetch failed: other side closed', 4)).toBe(true)
    expect(shouldRetryProviderStreamError('fetch failed: other side closed', 5)).toBe(false)
    expect(shouldRetryThrownStreamError(new RetriableStreamError('stream ended'), 1)).toBe(true)
    expect(shouldRetryThrownStreamError(new RetriableStreamError('stream ended'), 5)).toBe(false)
    expect(shouldRetryThrownStreamError(new DOMException('Aborted', 'AbortError'), 1)).toBe(false)
  })

  it('does not multiply connection retries at the stream layer', () => {
    expect(shouldRetryStreamErrorChunk('PROVIDER_NETWORK', 'fetch failed', 1)).toBe(false)
    expect(shouldRetryStreamErrorChunk('CIRCUIT_OPEN', 'Circuit open', 1)).toBe(false)
    expect(shouldRetryStreamErrorChunk('PROVIDER_STREAM', 'fetch failed: other side closed', 1)).toBe(
      true
    )
  })

  it('classifies retriable provider and thrown stream errors', () => {
    expect(decideStreamAttemptResult({ ok: true, outcome: 'complete' }, 1)).toEqual({
      action: 'complete'
    })
    expect(decideStreamAttemptResult({ ok: true, outcome: 'terminal' }, 1)).toEqual({
      action: 'terminal'
    })
    expect(decideStreamAttemptResult({ ok: true, outcome: 'retry' }, 1)).toEqual({
      action: 'retry'
    })
    expect(decideStreamAttemptResult({ ok: true, outcome: 'retry' }, 5)).toEqual({
      action: 'exhausted'
    })
    const err = new RetriableStreamError('stream ended')
    expect(decideStreamAttemptResult({ ok: false, err }, 1)).toEqual({ action: 'retry' })
    expect(
      decideStreamAttemptResult({ ok: false, err }, 5, { exhaustedOnLastRetriableThrow: true })
    ).toEqual({ action: 'exhausted', err })
    expect(decideStreamAttemptResult({ ok: false, err }, 5)).toEqual({ action: 'throw', err })
  })

  it('retries runAttempt on inline retry', async () => {
    const runAttempt = vi.fn().mockResolvedValueOnce('retry').mockResolvedValueOnce('complete')

    await runWithStreamRetry({
      onAttemptStart: vi.fn(),
      runAttempt
    })

    expect(runAttempt).toHaveBeenCalledTimes(2)
  })

  it('retries thrown retriable stream failures', async () => {
    const onRetriableFailure = vi.fn()
    const runAttempt = vi
      .fn()
      .mockRejectedValueOnce(new RetriableStreamError('stream ended'))
      .mockResolvedValueOnce('complete')

    await runWithStreamRetry({
      onAttemptStart: vi.fn(),
      onRetriableFailure,
      runAttempt
    })

    expect(runAttempt).toHaveBeenCalledTimes(2)
    expect(onRetriableFailure).toHaveBeenCalledTimes(1)
  })

  it('sleepStreamRetryBackoff waits for the shared delay', async () => {
    vi.useFakeTimers()
    const done = sleepStreamRetryBackoff(undefined, 1)
    await vi.advanceTimersByTimeAsync(streamRetryBackoffMs(1))
    await done
    vi.useRealTimers()
  })

  it('sleepStreamRetryBackoff throws when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleepStreamRetryBackoff(controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('throws when retries are exhausted', async () => {
    const runAttempt = vi.fn().mockResolvedValue('retry')
    await expect(
      runWithStreamRetry({
        onAttemptStart: vi.fn(),
        runAttempt
      })
    ).rejects.toBeInstanceOf(RetriableStreamError)
    expect(runAttempt).toHaveBeenCalledTimes(MAX_STREAM_ATTEMPTS)
  })

  it('runWithStreamRetryGen yields wait events and completes', async () => {
    const events: string[] = []
    const gen = runWithStreamRetryGen({
      onAttemptStart: function* (attempt) {
        if (attempt > 1) yield `reset:${attempt}`
      },
      waitBeforeRetry: function* (attempt) {
        yield `wait:${attempt}`
      },
      runAttempt: async function* (attempt) {
        yield `chunk:${attempt}`
        if (attempt === 1) return 'retry'
        return 'complete'
      }
    })

    let result: unknown
    while (true) {
      const next = await gen.next()
      if (next.done) {
        result = next.value
        break
      }
      events.push(next.value)
    }

    expect(events).toEqual(['chunk:1', 'wait:1', 'reset:2', 'chunk:2'])
    expect(result).toEqual({ status: 'complete' })
  })

  it('runWithStreamRetryGen returns exhausted on last retriable throw', async () => {
    const err = new RetriableStreamError('stream ended')
    const gen = runWithStreamRetryGen({
      onAttemptStart: () => undefined,
      waitBeforeRetry: function* () {
        yield 'wait'
      },
      runAttempt: async function* (attempt) {
        yield* []
        if (attempt < MAX_STREAM_ATTEMPTS) {
          throw err
        }
        throw err
      }
    })

    const events: string[] = []
    let result: unknown
    while (true) {
      const next = await gen.next()
      if (next.done) {
        result = next.value
        break
      }
      events.push(next.value)
    }

    expect(events).toHaveLength(MAX_STREAM_ATTEMPTS - 1)
    expect(events.every((e) => e === 'wait')).toBe(true)
    expect(result).toEqual({ status: 'exhausted', err })
  })

  it('runWithStreamRetryGen returns terminal without further attempts', async () => {
    const gen = runWithStreamRetryGen({
      onAttemptStart: () => undefined,
      waitBeforeRetry: function* () {
        yield 'wait'
      },
      runAttempt: async function* () {
        yield 'err-event'
        return 'terminal'
      }
    })

    const events: string[] = []
    let result: unknown
    while (true) {
      const next = await gen.next()
      if (next.done) {
        result = next.value
        break
      }
      events.push(next.value)
    }

    expect(events).toEqual(['err-event'])
    expect(result).toEqual({ status: 'terminal' })
  })

  it('classifies CircuitOpenError as exhausted without retrying', () => {
    const err = new CircuitOpenError('provider:openai', 60_000)
    expect(decideStreamAttemptResult({ ok: false, err }, 1)).toEqual({ action: 'exhausted', err })
  })

  it('skips stream attempts when the provider circuit is already open', async () => {
    const key = 'provider:circuit-test'
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordCircuitFailure(key)
    const runAttempt = vi.fn().mockResolvedValue('complete')
    await expect(
      runWithStreamRetry({
        circuitKey: key,
        onAttemptStart: vi.fn(),
        runAttempt
      })
    ).rejects.toBeInstanceOf(CircuitOpenError)
    expect(runAttempt).not.toHaveBeenCalled()
  })
})
