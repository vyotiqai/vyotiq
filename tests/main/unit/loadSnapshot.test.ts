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
  })

  it('logs a JSON load line when perf is enabled', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    logLoadSnapshot()
    expect(spy).toHaveBeenCalled()
    const args = spy.mock.calls[0]!
    expect(args[0]).toBe('[vyotiq-perf] load')
    expect(String(args[1])).toContain('"activeRuns"')
    spy.mockRestore()
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
