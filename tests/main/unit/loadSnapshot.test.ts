import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectLoadSnapshot,
  logLoadSnapshot,
  startLoadPerfMonitor,
  stopLoadPerfMonitor
} from '@main/perf/loadSnapshot'
import { resetActiveRunsForTests, registerRunAbort } from '@main/agent/runRegistry'
import { resetChatEventBatchStats, resetChatEventDispatcher } from '@main/ipc/streamBatch'
import { resetStatusWriteQueueForTests } from '@main/agent/statusWriteQueue'
import { resetTokenizerCache, resetTokenizerPerfStats } from '@main/agent/context/tokenizer'

vi.mock('@main/agent/context/perfDebug', () => ({
  isPerfDebugEnabled: () => true,
  perfNow: () => 0,
  perfLog: () => undefined
}))

vi.mock('@main/workspace/workspaces', () => ({
  getWorkspaces: () => ({
    openPaths: ['C:\\ws\\a', 'C:\\ws\\b'],
    recentPaths: [],
    activePath: 'C:\\ws\\a'
  })
}))

describe('loadSnapshot', () => {
  beforeEach(() => {
    stopLoadPerfMonitor()
    resetActiveRunsForTests()
    resetChatEventDispatcher()
    resetChatEventBatchStats()
    resetStatusWriteQueueForTests()
    resetTokenizerCache()
    resetTokenizerPerfStats()
  })

  afterEach(() => {
    stopLoadPerfMonitor()
    resetActiveRunsForTests()
  })

  it('collects concurrent-load counters', () => {
    registerRunAbort('run-1', 'C:\\ws\\a')
    registerRunAbort('run-2', 'C:\\ws\\b')
    const snap = collectLoadSnapshot()
    expect(snap.activeRuns).toBe(2)
    expect(snap.rejectedStarts).toBe(0)
    expect(snap.eventLoopLagP99).toBeGreaterThanOrEqual(0)
    expect(snap.openWorkspaces).toBe(2)
    expect(snap.activePath).toBe('C:\\ws\\a')
    expect(snap.chat).toMatchObject({
      pushed: 0,
      sent: 0,
      activeFlushes: 0,
      backgroundFlushes: 0
    })
    expect(snap.tokenizer).toMatchObject({
      workerBatches: 0,
      syncFallbacks: 0
    })
    expect(snap.statusWrites).toMatchObject({
      enqueued: 0,
      flushed: 0
    })
    expect(typeof snap.eventLoopLagMs).toBe('number')
    expect(typeof snap.heapUsedMb).toBe('number')
    expect(typeof snap.rssMb).toBe('number')
    expect(typeof snap.combinedRssMb).toBe('number')
    expect(snap.utility).toMatchObject({
      pid: null,
      sessionLoaded: false
    })
    expect(snap.heapUsedMb).toBeGreaterThan(0)
    expect(snap.rssMb).toBeGreaterThan(0)
  })

  it('logs a JSON load line when perf is enabled', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    logLoadSnapshot()
    expect(spy).toHaveBeenCalled()
    const args = spy.mock.calls[0]!
    expect(args[0]).toBe('[vyotiq-perf] load')
    expect(String(args[1])).toContain('"activeRuns"')
    expect(String(args[1])).toContain('"heapUsedMb"')
    spy.mockRestore()
  })

  it('logs heap-high when rss exceeds 1GB', () => {
    const memSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 1025 * 1024 * 1024,
      heapUsed: 600 * 1024 * 1024,
      heapTotal: 700 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0
    })
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    logLoadSnapshot()
    expect(spy).toHaveBeenCalledWith(
      '[vyotiq-perf] heap-high',
      expect.stringContaining('"rssMb":1025')
    )
    spy.mockRestore()
    memSpy.mockRestore()
  })

  it('starts and stops the periodic monitor', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    startLoadPerfMonitor()
    expect(spy).toHaveBeenCalledWith('[vyotiq-perf] load monitor started (every 5s)')
    spy.mockClear()
    vi.advanceTimersByTime(5_000)
    expect(spy.mock.calls.some((c) => c[0] === '[vyotiq-perf] load')).toBe(true)
    stopLoadPerfMonitor()
    spy.mockClear()
    vi.advanceTimersByTime(5_000)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    vi.useRealTimers()
  })
})
