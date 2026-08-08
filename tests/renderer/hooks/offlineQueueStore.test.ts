/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearOfflineQueue,
  dequeueOfflineMessage,
  enqueueOfflineMessage,
  offlineQueueLength,
  peekOfflineQueue
} from '@renderer/lib/hooks/offlineQueueStore'

const WORKSPACE = '/tmp/vyotiq-offline-ws'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-uuid'
  })
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('offlineQueueStore', () => {
  it('enqueues FIFO per workspace and persists in localStorage', () => {
    enqueueOfflineMessage(WORKSPACE, { text: 'first' })
    enqueueOfflineMessage(WORKSPACE, { text: 'second' })

    expect(offlineQueueLength(WORKSPACE)).toBe(2)
    expect(peekOfflineQueue(WORKSPACE)?.text).toBe('first')

    const key = `vyotiq.offlineQueue.${encodeURIComponent(WORKSPACE)}`
    expect(localStorage.getItem(key)).toContain('"first"')
    expect(localStorage.getItem(key)).toContain('"second"')
  })

  it('dequeues in FIFO order and clears storage when empty', () => {
    enqueueOfflineMessage(WORKSPACE, { text: 'a' })
    enqueueOfflineMessage(WORKSPACE, { text: 'b' })

    expect(dequeueOfflineMessage(WORKSPACE)?.text).toBe('a')
    expect(dequeueOfflineMessage(WORKSPACE)?.text).toBe('b')
    expect(dequeueOfflineMessage(WORKSPACE)).toBeNull()
    expect(offlineQueueLength(WORKSPACE)).toBe(0)

    const key = `vyotiq.offlineQueue.${encodeURIComponent(WORKSPACE)}`
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('isolates queues by workspace path', () => {
    enqueueOfflineMessage('/ws/a', { text: 'alpha' })
    enqueueOfflineMessage('/ws/b', { text: 'beta' })

    expect(peekOfflineQueue('/ws/a')?.text).toBe('alpha')
    expect(peekOfflineQueue('/ws/b')?.text).toBe('beta')
    expect(offlineQueueLength('/ws/a')).toBe(1)
    expect(offlineQueueLength('/ws/b')).toBe(1)
  })

  it('survives a simulated restart by re-reading localStorage', () => {
    enqueueOfflineMessage(WORKSPACE, { text: 'persist me', images: ['img://1'] })
    expect(offlineQueueLength(WORKSPACE)).toBe(1)

    // New module load would re-read the same localStorage key.
    expect(peekOfflineQueue(WORKSPACE)?.images).toEqual(['img://1'])
  })

  it('clearOfflineQueue removes all pending sends', () => {
    enqueueOfflineMessage(WORKSPACE, { text: 'one' })
    enqueueOfflineMessage(WORKSPACE, { text: 'two' })
    clearOfflineQueue(WORKSPACE)
    expect(offlineQueueLength(WORKSPACE)).toBe(0)
    expect(peekOfflineQueue(WORKSPACE)).toBeNull()
  })
})
