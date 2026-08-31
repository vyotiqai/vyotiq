import { describe, expect, it, vi } from 'vitest'
import { createTraceCapture, TRACE_CATEGORIES } from '@main/perf/traceCapture'

function fakeContentTracing() {
  return {
    startRecording: vi.fn(async () => undefined),
    stopRecording: vi.fn(async (path?: string) => path ?? ''),
    getTraceBufferUsage: vi.fn(async () => ({ value: 4242, percentage: 42 }))
  }
}

describe('traceCapture', () => {
  it('defaults categories and trace options when none are provided', async () => {
    const ct = fakeContentTracing()
    const capture = createTraceCapture(ct, () => 'C:/traces')
    const result = await capture.start()
    expect(ct.startRecording).toHaveBeenCalledWith({
      categoryFilter: TRACE_CATEGORIES,
      traceOptions: 'record-until-full,enable-sampling'
    })
    expect(result).toEqual({
      categoryFilter: TRACE_CATEGORIES,
      traceOptions: 'record-until-full,enable-sampling'
    })
  })

  it('passes through custom options and rejects a second concurrent start', async () => {
    const ct = fakeContentTracing()
    const capture = createTraceCapture(ct, () => 'C:/traces')
    const result = await capture.start({ categoryFilter: 'blink', traceOptions: 'record-continuously' })
    expect(result).toEqual({ categoryFilter: 'blink', traceOptions: 'record-continuously' })
    await expect(capture.start()).rejects.toThrow('already in progress')
    expect(ct.startRecording).toHaveBeenCalledTimes(1)
  })

  it('status reports recording state and buffer percent only while recording', async () => {
    const ct = fakeContentTracing()
    const capture = createTraceCapture(ct, () => 'C:/traces')
    expect(await capture.status()).toEqual({ recording: false, startedAt: null, bufferPercent: null })
    await capture.start()
    const status = await capture.status()
    expect(status.recording).toBe(true)
    expect(status.bufferPercent).toBe(42)
    expect(status.startedAt).toBeTruthy()
  })

  it('stop writes a timestamped file path under the trace dir and returns byte size', async () => {
    const ct = fakeContentTracing()
    let clock = 1_000_000
    const capture = createTraceCapture(ct, () => 'C:/traces', () => clock)
    await capture.start()
    clock += 1_000 // past the 250ms too-short guard
    const result = await capture.stop()
    expect(ct.stopRecording).toHaveBeenCalledTimes(1)
    const writtenPath = ct.stopRecording.mock.calls[0]?.[0] as string
    // join() normalizes separators per-OS (C:\traces\… on Windows).
    expect(writtenPath.replace(/\\/g, '/').startsWith('C:/traces/trace-')).toBe(true)
    expect(writtenPath.endsWith('.json')).toBe(true)
    expect(result.path).toBe(writtenPath)
    // Real statSync fails on the fake path → falls back to 0 (documented behavior).
    expect(result.bytes).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect((await capture.status()).recording).toBe(false)
  })

  it('rejects stop when not recording', async () => {
    const capture = createTraceCapture(fakeContentTracing(), () => 'C:/traces')
    await expect(capture.stop()).rejects.toThrow('No trace recording in progress')
  })

  it('rejects stop for sub-250ms captures so files are never empty', async () => {
    let clock = 1_000_000
    const capture = createTraceCapture(fakeContentTracing(), () => 'C:/traces', () => clock)
    await capture.start()
    clock += 100
    await expect(capture.stop()).rejects.toThrow('too short')
  })

  it('swallows getTraceBufferUsage failures in status', async () => {
    const ct = fakeContentTracing()
    ct.getTraceBufferUsage.mockRejectedValueOnce(new Error('no buffer'))
    const capture = createTraceCapture(ct, () => 'C:/traces')
    await capture.start()
    const status = await capture.status()
    expect(status.recording).toBe(true)
    expect(status.bufferPercent).toBeNull()
  })
})
