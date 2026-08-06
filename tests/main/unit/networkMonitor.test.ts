import { afterEach, describe, expect, it, vi } from 'vitest'
import { iterateNetworkWait } from '@main/agent/networkMonitor'

describe('iterateNetworkWait', () => {
  const savedVitest = process.env.VITEST

  afterEach(() => {
    process.env.VITEST = savedVitest
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('yields retry intervals before each offline sleep', async () => {
    process.env.VITEST = 'false'
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    vi.useFakeTimers()

    const intervals: number[] = []
    const pending = (async () => {
      for await (const retryInMs of iterateNetworkWait({ maxWaitMs: 10_000 })) {
        intervals.push(retryInMs)
      }
    })()

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    await pending

    expect(intervals).toEqual([2000, 2000])
  })
})
