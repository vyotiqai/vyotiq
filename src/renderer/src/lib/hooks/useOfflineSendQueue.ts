import { useCallback, useEffect, useState } from 'react'
import type { AttachedFile, ComposerSendExtras } from '@shared/ipc'
import { useNetworkStatus } from './useNetworkStatus'
import {
  clearOfflineQueue,
  dequeueOfflineMessage,
  enqueueOfflineMessage,
  offlineQueueLength,
  peekOfflineQueue
} from './offlineQueueStore'

type SendHandler = (
  text: string,
  images?: string[],
  files?: AttachedFile[],
  extras?: ComposerSendExtras
) => boolean | void | Promise<boolean | void>

/** Prevents duplicate flush loops when two owners briefly share a workspace. */
const flushingWorkspaces = new Set<string>()

export function useOfflineSendQueue(
  workspacePath: string,
  onSend: SendHandler
): {
  online: boolean
  offlineHint: string | null
  sendWithOfflineQueue: (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras,
    deliver?: SendHandler
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
      deliver?: SendHandler
    ) => {
      if (!online && workspacePath) {
        enqueueOfflineMessage(workspacePath, { text, images, files, extras })
        bumpQueue()
        return true
      }
      const target = deliver ?? onSend
      return Boolean(await target(text, images, files, extras))
    },
    [online, workspacePath, onSend, bumpQueue]
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
            const ok = Boolean(await onSend(next.text, next.images, next.files, next.extras))
            if (!ok) break
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
  }, [online, workspacePath, onSend, bumpQueue, queueTick])

  return { online, offlineHint, sendWithOfflineQueue, clearOfflineQueueForWorkspace }
}

/** Test helper: reset in-memory flush locks between cases. */
export function resetOfflineFlushLocksForTests(): void {
  flushingWorkspaces.clear()
}
