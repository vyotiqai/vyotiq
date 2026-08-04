import { useCallback, useSyncExternalStore } from 'react'
import type { AttachedAudio, AttachedFile, AttachedNativeFile } from '@shared/ipc'

/**
 * Per-workspace composer attachments (images, files, audio).
 * Survives Composer remounts on run-tab switches, like the hot-UI draft store.
 * Session-scoped only — never written to disk.
 */

export type ComposerAttachmentState = {
  images: string[]
  files: AttachedFile[]
  nativeFiles: AttachedNativeFile[]
  audio: AttachedAudio[]
}

const EMPTY_ATTACHMENTS: ComposerAttachmentState = Object.freeze({
  images: [],
  files: [],
  nativeFiles: [],
  audio: []
})

const byPath = new Map<string, ComposerAttachmentState>()
const listenersByPath = new Map<string, Set<() => void>>()

function notify(path: string): void {
  const listeners = listenersByPath.get(path)
  if (listeners) {
    for (const listener of listeners) listener()
  }
}

export function getComposerAttachments(path: string | null | undefined): ComposerAttachmentState {
  if (!path) return EMPTY_ATTACHMENTS
  return byPath.get(path) ?? EMPTY_ATTACHMENTS
}

export function setComposerAttachments(
  path: string,
  patch: Partial<ComposerAttachmentState>
): void {
  const prev = byPath.get(path) ?? EMPTY_ATTACHMENTS
  const next: ComposerAttachmentState = {
    images: patch.images !== undefined ? patch.images : prev.images,
    files: patch.files !== undefined ? patch.files : prev.files,
    nativeFiles: patch.nativeFiles !== undefined ? patch.nativeFiles : prev.nativeFiles,
    audio: patch.audio !== undefined ? patch.audio : prev.audio
  }
  if (
    next.images === prev.images &&
    next.files === prev.files &&
    next.nativeFiles === prev.nativeFiles &&
    next.audio === prev.audio &&
    byPath.has(path)
  ) {
    return
  }
  byPath.set(path, next)
  notify(path)
}

export function clearComposerAttachments(path: string): void {
  if (!byPath.has(path)) return
  byPath.delete(path)
  notify(path)
}

export function subscribeComposerAttachments(
  path: string | null | undefined,
  listener: () => void
): () => void {
  if (!path) return () => {}
  let set = listenersByPath.get(path)
  if (!set) {
    set = new Set()
    listenersByPath.set(path, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listenersByPath.delete(path)
  }
}

/** Subscribe to one workspace's composer attachments (no-op when unbound). */
export function useComposerAttachments(path: string | null | undefined): ComposerAttachmentState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeComposerAttachments(path, onStoreChange),
    [path]
  )
  const getSnapshot = useCallback(() => getComposerAttachments(path), [path])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Test helper — reset module state between cases. */
export function resetComposerAttachmentStoreForTests(): void {
  byPath.clear()
  listenersByPath.clear()
}
