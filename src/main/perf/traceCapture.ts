/**
 * Opt-in Chromium trace capture (chrome://tracing JSON) for startup, IPC, and
 * renderer-frame diagnosis. On-demand only: nothing runs until an invoke asks
 * for it, so idle CPU/disk cost is zero (performance rule: measure first).
 *
 * Traces land under {userData}/traces/ (same volume as logs, never the
 * workspace). Categories stay narrow — resize/layout GPU subtests are off by
 * default because they cost frames while recording.
 */
import { join } from 'path'
import { statSync } from 'fs'
import { logger } from '../../shared/logger'

export const TRACE_CATEGORIES =
  'devtools.timeline,v8,blink,disabled-by-default-devtools.timeline.frame'

type TraceStartOptions = {
  traceOptions?: string
  categoryFilter?: string
}

type ContentTracingLike = {
  startRecording: (
    options: Electron.TraceCategoriesAndOptions | Electron.TraceConfig
  ) => Promise<void>
  stopRecording: (resultFilePath?: string) => Promise<string>
  getTraceBufferUsage: () => Promise<{ value: number; percentage: number }>
}

export type TraceStartResult = { categoryFilter: string; traceOptions: string }
export type TraceStopResult = { path: string; bytes: number; durationMs: number }

const DEFAULT_TRACE_OPTIONS = 'record-until-full,enable-sampling'
const MIN_STOP_GAP_MS = 250

export function createTraceCapture(
  contentTracing: ContentTracingLike,
  resolveTraceDir: () => string,
  now: () => number = Date.now
): {
  start: (options?: TraceStartOptions) => Promise<TraceStartResult>
  status: () => Promise<{ recording: boolean; startedAt: string | null; bufferPercent: number | null }>
  stop: () => Promise<TraceStopResult>
} {
  let recording = false
  let startedAtMs: number | null = null

  return {
    async start(options?: TraceStartOptions): Promise<TraceStartResult> {
      if (recording) throw new Error('Trace recording already in progress')
      const requested = {
        categoryFilter: options?.categoryFilter?.trim() || TRACE_CATEGORIES,
        traceOptions: options?.traceOptions?.trim() || DEFAULT_TRACE_OPTIONS
      }
      await contentTracing.startRecording(requested)
      recording = true
      startedAtMs = now()
      logger.info('Trace recording started', {
        scope: 'perf',
        kind: 'trace',
        action: 'start'
      })
      return requested
    },

    async status() {
      let bufferPercent: number | null = null
      if (recording) {
        try {
          bufferPercent = (await contentTracing.getTraceBufferUsage()).percentage
        } catch {
          bufferPercent = null
        }
      }
      return {
        recording,
        startedAt:
          recording && startedAtMs != null ? new Date(startedAtMs).toISOString() : null,
        bufferPercent
      }
    },

    async stop(): Promise<TraceStopResult> {
      if (!recording) throw new Error('No trace recording in progress')
      const elapsed = startedAtMs != null ? now() - startedAtMs : 0
      if (startedAtMs != null && elapsed < MIN_STOP_GAP_MS) {
        throw new Error('Trace recording too short — capture at least a second of activity')
      }
      const dir = resolveTraceDir()
      const path = join(dir, `trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      // Clear before awaiting so status() can't report a stale recording and a
      // concurrent stop can't double-fire while stopRecording is in flight.
      recording = false
      startedAtMs = null
      const written = await contentTracing.stopRecording(path)
      const bytes = (() => {
        try {
          return statSync(written).size
        } catch {
          return 0
        }
      })()
      logger.info('Trace recording stopped', {
        scope: 'perf',
        kind: 'trace',
        action: 'stop',
        count: bytes
      })
      return { path: written, bytes, durationMs: Math.max(0, elapsed) }
    }
  }
}
