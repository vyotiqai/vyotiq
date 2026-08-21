import type { AttachedFile, ComposerSendExtras } from '@shared/ipc'

export type OfflineQueuedSend = {
  id: string
  text: string
  images?: string[]
  files?: AttachedFile[]
  extras?: ComposerSendExtras
  /** Pane/run that queued the send — flush must not use whatever is focused later. */
  runId?: string | null
  /** Stable pane id so a draft can flush after it is promoted to a real run. */
  paneId?: string
  /** Workspace that owned the send — do not substitute the focused workspace. */
  workspacePath?: string
  queuedAt: string
}

export type OfflineFlushPane = {
  paneId: string
  workspacePath: string
  runId: string | null
}

/**
 * Resolve the controller binding for an offline flush.
 * Never falls back to the currently focused pane for `runId: null`.
 */
export function resolveOfflineFlushTarget(
  entry: OfflineQueuedSend,
  panes: readonly OfflineFlushPane[],
  fallbackWorkspacePath?: string
): { workspacePath: string; runId: string | null } | null {
  if (entry.paneId) {
    const pane = panes.find((p) => p.paneId === entry.paneId)
    if (pane) {
      return { workspacePath: pane.workspacePath, runId: pane.runId }
    }
  }
  if (typeof entry.runId === 'string' && entry.runId.length > 0) {
    const path = entry.workspacePath || fallbackWorkspacePath
    if (typeof path === 'string' && path.length > 0) {
      return { workspacePath: path, runId: entry.runId }
    }
  }
  return null
}

function storageKey(workspacePath: string): string {
  return `vyotiq.offlineQueue.${encodeURIComponent(workspacePath)}`
}

function readQueue(workspacePath: string): OfflineQueuedSend[] {
  if (!workspacePath || typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(storageKey(workspacePath))
    if (!raw) return []
    const parsed = JSON.parse(raw) as OfflineQueuedSend[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeQueue(workspacePath: string, queue: OfflineQueuedSend[]): boolean {
  if (!workspacePath || typeof localStorage === 'undefined') return false
  try {
    if (queue.length === 0) {
      localStorage.removeItem(storageKey(workspacePath))
      return true
    }
    localStorage.setItem(storageKey(workspacePath), JSON.stringify(queue))
    return true
  } catch {
    return false
  }
}

export function offlineQueueLength(workspacePath: string): number {
  return readQueue(workspacePath).length
}

export function enqueueOfflineMessage(
  workspacePath: string,
  payload: Omit<OfflineQueuedSend, 'id' | 'queuedAt'>
): OfflineQueuedSend | null {
  const entry: OfflineQueuedSend = {
    ...payload,
    id: crypto.randomUUID(),
    queuedAt: new Date().toISOString()
  }
  return writeQueue(workspacePath, [...readQueue(workspacePath), entry]) ? entry : null
}

export function peekOfflineQueue(workspacePath: string): OfflineQueuedSend | null {
  return readQueue(workspacePath)[0] ?? null
}

export function dequeueOfflineMessage(workspacePath: string): OfflineQueuedSend | null {
  const queue = readQueue(workspacePath)
  if (queue.length === 0) return null
  const [head, ...rest] = queue
  writeQueue(workspacePath, rest)
  return head ?? null
}

export function clearOfflineQueue(workspacePath: string): void {
  writeQueue(workspacePath, [])
}

/** Drop queued sends bound to a deleted run (null/undefined entries are kept). */
export function removeOfflineQueueEntriesForRun(
  workspacePath: string,
  runId: string
): void {
  if (!workspacePath || !runId) return
  const next = readQueue(workspacePath).filter((entry) => entry.runId !== runId)
  writeQueue(workspacePath, next)
}
