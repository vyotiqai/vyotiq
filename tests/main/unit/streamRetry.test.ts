import { describe, expect, it, vi } from 'vitest'
import { RetriableStreamError } from '@main/agent/providers/fetchWithRetry'
import {
  MAX_STREAM_ATTEMPTS,
  runWithStreamRetry,
  shouldRetryProviderStreamError,
  shouldRetryThrownStreamError,
  sleepStreamRetryBackoff,
  STREAM_RETRY_BACKOFF_MS
} from '@main/agent/streamRetry'

describe('streamRetry', () => {
  it('exports shared retry constants', () => {
    expect(MAX_STREAM_ATTEMPTS).toBe(2)
    expect(STREAM_RETRY_BACKOFF_MS).toBe(750)
  })

  it('classifies retriable provider and thrown stream errors', () => {
    expect(shouldRetryProviderStreamError('fetch failed: other side closed', 1)).toBe(true)
    expect(shouldRetryProviderStreamError('fetch failed: other side closed', 2)).toBe(false)
    expect(shouldRetryThrownStreamError(new RetriableStreamError('stream ended'), 1)).toBe(true)
    expect(shouldRetryThrownStreamError(new RetriableStreamError('stream ended'), 2)).toBe(false)
    expect(shouldRetryThrownStreamError(new DOMException('Aborted', 'AbortError'), 1)).toBe(false)
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
    const done = sleepStreamRetryBackoff()
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_BACKOFF_MS)
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
})
