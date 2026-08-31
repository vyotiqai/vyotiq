/**
 * Automatic trace flight-recorder wiring. ON by default, zero manual steps:
 *  - Boot: starts the record-continuously ring buffer (traceCapture).
 *  - Renderer crash (non-killed/clean), child-process crash (non-clean),
 *    renderer unresponsive (attached per webContents via
 *    browser-window-created), uncaughtException/unhandledRejection → dump the
 *    ring buffer to {userData}/traces/ and resume recording (30s auto
 *    cool-down dedupes trigger storms; manual IPC dumps always force).
 *
 * Reliability note (honest): renderer-crash / child-crash / unresponsive
 * dumps are fully reliable because main survives. uncaughtException and
 * unhandledRejection are FATAL in this app (logging/init exits after a
 * 250ms flush) — those dumps are best-effort: this module registers its
 * process listener FIRST (initTraceAutoCapture runs before initMainLogging)
 * so the dump gets the full flush window, but a huge buffer can still lose
 * the tail. Crashpad minidumps + vyotiq.log remain the primary fatal-path
 * artifacts; the trace is a bonus when it lands.
 */
import { mkdirSync } from 'fs'
import { join } from 'path'
import { logger } from '../../shared/logger'
import {
  createTraceCapture,
  type TraceCapture,
  type TraceDumpReason
} from './traceCapture'

type CrashDetailsLike = { reason: string }
type ChildDetailsLike = { reason: string }

type AppLike = {
  on: (event: string, listener: (...args: never[]) => void) => unknown
  getPath: (name: 'userData') => string
}

export type TraceAutoCapture = {
  /** Idempotent boot: start the ring buffer + attach crash/hang triggers. */
  init: () => void
  capture: TraceCapture
}

export function createTraceAutoCapture(
  contentTracing: Parameters<typeof createTraceCapture>[0],
  app: AppLike,
  proc: Pick<NodeJS.Process, 'on'>
): TraceAutoCapture {
  const capture = createTraceCapture(contentTracing, () => {
    // Traces live in {userData}/traces/ (same volume as logs, never the
    // workspace) — mkdir here so dump paths always resolve.
    const dir = join(app.getPath('userData'), 'traces')
    mkdirSync(dir, { recursive: true })
    return dir
  })
  let initialized = false

  const dump = (reason: TraceDumpReason): void => {
    void capture.dumpNow(reason).catch((err: unknown) => {
      // Cool-down skips and fs failures must never surface as unhandled.
      logger.warn('Automatic trace dump did not run', {
        scope: 'perf',
        kind: 'trace',
        reason,
        err
      })
    })
  }

  return {
    capture,
    init(): void {
      if (initialized) return
      initialized = true

      void capture
        .ensureRecording()
        .then(() => {
          logger.info('Trace flight recorder active (automatic)', {
            scope: 'perf',
            kind: 'trace'
          })
        })
        .catch((err: unknown) => {
          logger.warn('Trace flight recorder failed to start', {
            scope: 'perf',
            kind: 'trace',
            err
          })
        })

      app.on('render-process-gone', ((_event: unknown, _wc: unknown, details: CrashDetailsLike) => {
        if (details.reason === 'killed' || details.reason === 'clean-exit') return
        dump('renderer-crash')
      }) as never)

      app.on('child-process-gone', ((_event: unknown, details: ChildDetailsLike) => {
        if (details.reason === 'clean-exit' || details.reason === 'killed') return
        dump('child-process-crash')
      }) as never)

      app.on('browser-window-created', ((_event: unknown, win: { webContents: { on: (event: string, listener: () => void) => void; isDestroyed: () => boolean } }) => {
        win.webContents.on('unresponsive', () => {
          if (win.webContents.isDestroyed()) return
          dump('renderer-unresponsive')
        })
      }) as never)

      // Register BEFORE logging/init's fatal handler so the dump starts
      // inside the 250ms pre-exit flush window (best-effort — see header).
      proc.on('uncaughtException', (() => {
        dump('uncaught-exception')
      }) as never)
      proc.on('unhandledRejection', (() => {
        dump('unhandled-rejection')
      }) as never)
    }
  }
}

let instance: TraceAutoCapture | null = null

/**
 * Process-wide singleton accessor. Creates + initializes on first call.
 * Called at boot (main/index.ts, before initMainLogging so fatal-path dump
 * listeners register first) and lazily from IPC handlers.
 */
export function getTraceAutoCapture(): TraceAutoCapture {
  if (!instance) {
    // Lazy require keeps unit tests that import this module off Electron.
    const electron = require('electron') as { app: AppLike; contentTracing: Parameters<typeof createTraceCapture>[0] }
    instance = createTraceAutoCapture(electron.contentTracing, electron.app, process)
  }
  return instance
}

/**
 * Boot hook. ON by default; VYOTIQ_TRACE_OFF=1 is a measurement/diagnostics
 * opt-out only (no settings surface) so the flight recorder's cost can be
 * A/B measured per the STRICT perf rule.
 */
export function initTraceAutoCapture(): void {
  if (process.env.VYOTIQ_TRACE_OFF === '1') {
    logger.info('Trace flight recorder disabled (VYOTIQ_TRACE_OFF=1)', {
      scope: 'perf',
      kind: 'trace'
    })
    return
  }
  instance ??= getTraceAutoCapture()
  instance.init()
}

/** @internal */
export function resetTraceAutoCaptureForTests(): void {
  instance = null
}
