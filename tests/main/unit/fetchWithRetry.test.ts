import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchWithRetry,
  isRetriableNetworkError,
  isRetriableProviderMessage,
  retryAfterMs,
  RetriableStreamError
} from '@main/agent/providers/fetchWithRetry'

describe('isRetriableNetworkError', () => {
  it('detects ECONNRESET on cause chain', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const err = new TypeError('terminated', { cause })
    expect(isRetriableNetworkError(err)).toBe(true)
  })

  it('detects other side closed message', () => {
    expect(isRetriableNetworkError(new Error('fetch failed: other side closed'))).toBe(true)
  })

  it('rejects abort errors', () => {
    expect(isRetriableNetworkError(new DOMException('Aborted', 'AbortError'))).toBe(false)
  })
})

describe('isRetriableProviderMessage', () => {
  it('matches transient provider disconnect phrases', () => {
    expect(isRetriableProviderMessage('fetch failed: other side closed')).toBe(true)
    expect(isRetriableProviderMessage('read ECONNRESET')).toBe(true)
    expect(isRetriableProviderMessage('HTTP 401: unauthorized')).toBe(false)
  })
})

describe('RetriableStreamError', () => {
  it('wraps stream read failures', () => {
    const inner = new Error('read ECONNRESET')
    const err = new RetriableStreamError('stream ended', inner)
    expect(err.name).toBe('RetriableStreamError')
    expect(err.cause).toBe(inner)
  })
})

describe('retryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterMs('2')).toBe(2000)
  })

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000)
  })

  it('clamps a far-future date to the cap', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(retryAfterMs('Thu, 01 Jan 2027 00:00:00 GMT', now)).toBe(30_000)
  })

  it('ignores missing or unparseable values', () => {
    expect(retryAfterMs(null)).toBeUndefined()
    expect(retryAfterMs('soon')).toBeUndefined()
  })
})

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function response(status: number, headers: Record<string, string> = {}): Response {
    return new Response(status === 204 ? null : 'body', { status, headers })
  }

  it('drains the body of a retried 5xx so the connection is released', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const failing = response(503)
    Object.defineProperty(failing, 'body', { value: { cancel } })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failing)
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchWithRetry('https://example.test', {})

    expect(res.status).toBe(200)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waits for Retry-After on a 429 instead of the default backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)

    const started = Date.now()
    const res = await fetchWithRetry('https://example.test', {})

    expect(res.status).toBe(200)
    // The default jittered backoff for attempt 1 tops out at 250ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it('stops retrying once the caller aborts', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort()
      return response(503)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchWithRetry('https://example.test', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws AbortError when aborted during network retry backoff', async () => {
    const controller = new AbortController()
    const fetchMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = fetchWithRetry('https://example.test', { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
