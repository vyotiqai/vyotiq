import type { AttachedFile, ComposerSendExtras } from '@shared/ipc'

export type OfflineQueuedSend = {
  id: string
  text: string
  images?: string[]
  files?: AttachedFile[]
  extras?: ComposerSendExtras
  queuedAt: string
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

function writeQueue(workspacePath: string, queue: OfflineQueuedSend[]): void {
  if (!workspacePath || typeof localStorage === 'undefined') return
  try {
    if (queue.length === 0) {
      localStorage.removeItem(storageKey(workspacePath))
      return
    }
    localStorage.setItem(storageKey(workspacePath), JSON.stringify(queue))
  } catch {
    // best-effort
  }
}

export function offlineQueueLength(workspacePath: string): number {
  return readQueue(workspacePath).length
}

export function enqueueOfflineMessage(
  workspacePath: string,
  payload: Omit<OfflineQueuedSend, 'id' | 'queuedAt'>
): OfflineQueuedSend {
  const entry: OfflineQueuedSend = {
    ...payload,
    id: crypto.randomUUID(),
    queuedAt: new Date().toISOString()
  }
  writeQueue(workspacePath, [...readQueue(workspacePath), entry])
  return entry
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
