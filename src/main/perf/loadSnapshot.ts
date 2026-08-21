/**
 * Opt-in concurrent-load snapshot for multi-workspace / multi-run repros.
 * Enable with VYOTIQ_PERF=1 — logs `[vyotiq-perf] load` every LOAD_SNAPSHOT_MS.
 */
import { isPerfDebugEnabled } from '../agent/context/perfDebug'
import { getTokenizerPerfStats } from '../agent/context/tokenizer'
import {
  getEmbedUtilityPerfStats,
  refreshEmbedUtilityPerfStatsBestEffort,
  type EmbedUtilityPerfStats
} from '../agent/codeindex/embedUtilityClient'
import { listActiveRuns, getRejectedRunStarts } from '../agent/runRegistry'
import { getStatusWriteQueueStats } from '../agent/statusWriteQueue'
import {
  getChatEventBatchStats,
  getChatEventDispatcherSnapshot
} from '../ipc/streamBatch'
import { getWorkspaces } from '../workspace/workspaces'

const LOAD_SNAPSHOT_MS = 5_000

export type LoadSnapshot = {
  at: string
  activeRuns: number
  rejectedStarts: number
  openWorkspaces: number
  activePath: string | null
  eventLoopLagMs: number
  eventLoopLagP99: number
  heapUsedMb: number
  rssMb: number
  /** Combined main RSS + last-known utility RSS (when available). */
  combinedRssMb: number
  utility: EmbedUtilityPerfStats
  chat: ReturnType<typeof getChatEventBatchStats>
  dispatcher: ReturnType<typeof getChatEventDispatcherSnapshot>
  statusWrites: ReturnType<typeof getStatusWriteQueueStats>
  tokenizer: ReturnType<typeof getTokenizerPerfStats>
}

let timer: ReturnType<typeof setInterval> | null = null
let lagTimer: ReturnType<typeof setInterval> | null = null
let lastLagMs = 0
const lagSamples: number[] = []
const LAG_SAMPLE_CAP = 120

function sampleEventLoopLag(): void {
  const sent = Date.now()
  setImmediate(() => {
    lastLagMs = Date.now() - sent
    lagSamples.push(lastLagMs)
    if (lagSamples.length > LAG_SAMPLE_CAP) lagSamples.shift()
  })
}

function eventLoopLagP99(): number {
  if (lagSamples.length === 0) return lastLagMs
  const sorted = [...lagSamples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)
  return sorted[Math.max(0, idx)] ?? lastLagMs
}

export function collectLoadSnapshot(): LoadSnapshot {
  const ws = getWorkspaces()
  const mem = process.memoryUsage()
  const rssMb = Math.round(mem.rss / 1024 / 1024)
  const utility = getEmbedUtilityPerfStats()
  const utilityRss = utility.rssMb ?? 0
  return {
    at: new Date().toISOString(),
    activeRuns: listActiveRuns().length,
    rejectedStarts: getRejectedRunStarts(),
    openWorkspaces: ws.openPaths.length,
    activePath: ws.activePath,
    eventLoopLagMs: lastLagMs,
    eventLoopLagP99: eventLoopLagP99(),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    rssMb,
    combinedRssMb: rssMb + utilityRss,
    utility,
    chat: getChatEventBatchStats(),
    dispatcher: getChatEventDispatcherSnapshot(),
    statusWrites: getStatusWriteQueueStats(),
    tokenizer: getTokenizerPerfStats()
  }
}

export function logLoadSnapshot(): void {
  if (!isPerfDebugEnabled()) return
  refreshEmbedUtilityPerfStatsBestEffort()
  const snap = collectLoadSnapshot()
  console.info('[vyotiq-perf] load', JSON.stringify(snap))
  if (snap.combinedRssMb > 1024 || snap.rssMb > 1024) {
    console.warn(
      '[vyotiq-perf] heap-high',
      JSON.stringify({
        rssMb: snap.rssMb,
        combinedRssMb: snap.combinedRssMb,
        utilityRssMb: snap.utility.rssMb,
        heapUsedMb: snap.heapUsedMb
      })
    )
  }
}

/** Start periodic load snapshots + event-loop lag sampling (no-op unless VYOTIQ_PERF=1). */
export function startLoadPerfMonitor(): void {
  if (!isPerfDebugEnabled()) return
  if (timer) return
  sampleEventLoopLag()
  lagTimer = setInterval(sampleEventLoopLag, 500)
  timer = setInterval(logLoadSnapshot, LOAD_SNAPSHOT_MS)
  console.info('[vyotiq-perf] load monitor started (every 5s)')
}

export function stopLoadPerfMonitor(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (lagTimer) {
    clearInterval(lagTimer)
    lagTimer = null
  }
  lastLagMs = 0
  lagSamples.length = 0
}
