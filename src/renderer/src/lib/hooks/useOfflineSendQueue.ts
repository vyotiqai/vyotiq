import { useCallback, useEffect, useState } from 'react'
import type { AttachedFile, ComposerSendExtras } from '@shared/ipc'
import { useNetworkStatus } from './useNetworkStatus'
import {
  clearOfflineQueue,
  dequeueOfflineMessage,
  enqueueOfflineMessage,
  offlineQueueLength,
  peekOfflineQueue,
  type OfflineQueuedSend
} from './offlineQueueStore'

type SendHandler = (
  text: string,
  images?: string[],
  files?: AttachedFile[],
  extras?: ComposerSendExtras
) => boolean | void | Promise<boolean | void>

type FlushHandler = (entry: OfflineQueuedSend) => boolean | void | Promise<boolean | void>

/** Prevents duplicate flush loops when two owners briefly share a workspace. */
const flushingWorkspaces = new Set<string>()

export function useOfflineSendQueue(
  workspacePath: string,
  onFlush: FlushHandler
): {
  online: boolean
  offlineHint: string | null
  sendWithOfflineQueue: (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras,
    deliver?: SendHandler,
    binding?: { runId?: string | null; paneId?: string; workspacePath?: string }
  ) => Promise<boolean>
  clearOfflineQueueForWorkspace: () => void
} {
  const { online, offlineHint: networkOfflineHint } = useNetworkStatus()
  const [queueTick, setQueueTick] = useState(0)
  const queuedCount = workspacePath ? offlineQueueLength(workspacePath) : 0
  const offlineHint =
    queuedCount > 0
      ? `${queuedCount} message${queuedCount === 1 ? '' : 's'} queued — will send when online`
      : networkOfflineHint

  const bumpQueue = useCallback(() => {
    setQueueTick((n) => n + 1)
  }, [])

  const clearOfflineQueueForWorkspace = useCallback(() => {
    if (!workspacePath) return
    clearOfflineQueue(workspacePath)
    bumpQueue()
  }, [workspacePath, bumpQueue])

  const sendWithOfflineQueue = useCallback(
    async (
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: ComposerSendExtras,
      deliver?: SendHandler,
      binding?: { runId?: string | null; paneId?: string; workspacePath?: string }
    ) => {
      const queuePath = binding?.workspacePath ?? workspacePath
      if (!online && queuePath) {
        const queued = enqueueOfflineMessage(queuePath, {
          text,
          images,
          files,
          extras,
          runId: binding?.runId,
          paneId: binding?.paneId,
          workspacePath: queuePath
        })
        if (!queued) return false
        bumpQueue()
        return true
      }
      if (deliver) return Boolean(await deliver(text, images, files, extras))
      return Boolean(
        await onFlush({
          id: '',
          text,
          images,
          files,
          extras,
          runId: binding?.runId,
          paneId: binding?.paneId,
          workspacePath: queuePath || undefined,
          queuedAt: ''
        })
      )
    },
    [online, workspacePath, onFlush, bumpQueue]
  )

  useEffect(() => {
    if (!online || !workspacePath) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (cancelled || flushingWorkspaces.has(workspacePath)) return
      flushingWorkspaces.add(workspacePath)
      void (async () => {
        try {
          while (!cancelled) {
            const next = peekOfflineQueue(workspacePath)
            if (!next) break
            let ok = false
            try {
              ok = Boolean(await onFlush(next))
            } catch {
              // Transient failure (e.g. workspace still indexing). Keep the message
              // queued and retry on the next tick instead of stranding it forever.
              ok = false
            }
            if (!ok) {
              bumpQueue()
              break
            }
            dequeueOfflineMessage(workspacePath)
            bumpQueue()
          }
        } finally {
          flushingWorkspaces.delete(workspacePath)
        }
      })()
    }, 2_000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [online, workspacePath, onFlush, bumpQueue, queueTick])

  return { online, offlineHint, sendWithOfflineQueue, clearOfflineQueueForWorkspace }
}

/** Test helper: reset in-memory flush locks between cases. */
export function resetOfflineFlushLocksForTests(): void {
  flushingWorkspaces.clear()
}
