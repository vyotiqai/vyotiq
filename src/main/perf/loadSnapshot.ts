/**
 * Opt-in concurrent-load snapshot for multi-workspace / multi-run repros.
 * Enable with VYOTIQ_PERF=1 — logs `[vyotiq-perf] load` every LOAD_SNAPSHOT_MS.
 */
import { isPerfDebugEnabled } from '../agent/context/perfDebug'
import { getTokenizerPerfStats } from '../agent/context/tokenizer'
import { listActiveRuns } from '../agent/runRegistry'
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
  openWorkspaces: number
  activePath: string | null
  eventLoopLagMs: number
  chat: ReturnType<typeof getChatEventBatchStats>
  dispatcher: ReturnType<typeof getChatEventDispatcherSnapshot>
  statusWrites: ReturnType<typeof getStatusWriteQueueStats>
  tokenizer: ReturnType<typeof getTokenizerPerfStats>
}

let timer: ReturnType<typeof setInterval> | null = null
let lagTimer: ReturnType<typeof setInterval> | null = null
let lastLagMs = 0

function sampleEventLoopLag(): void {
  const sent = Date.now()
  setImmediate(() => {
    lastLagMs = Date.now() - sent
  })
}

export function collectLoadSnapshot(): LoadSnapshot {
  const ws = getWorkspaces()
  return {
    at: new Date().toISOString(),
    activeRuns: listActiveRuns().length,
    openWorkspaces: ws.openPaths.length,
    activePath: ws.activePath,
    eventLoopLagMs: lastLagMs,
    chat: getChatEventBatchStats(),
    dispatcher: getChatEventDispatcherSnapshot(),
    statusWrites: getStatusWriteQueueStats(),
    tokenizer: getTokenizerPerfStats()
  }
}

export function logLoadSnapshot(): void {
  if (!isPerfDebugEnabled()) return
  console.info('[vyotiq-perf] load', JSON.stringify(collectLoadSnapshot()))
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
}
