import { useCallback, useSyncExternalStore } from 'react'
import type { AttachedAudio, AttachedFile, AttachedNativeFile } from '@shared/ipc'
import { HOT_COMPOSER_DRAFT_KEY } from './workspaceHotUiStore'

/**
 * Per-workspace (and per-run) composer attachments (images, files, audio).
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

const byKey = new Map<string, ComposerAttachmentState>()
const listenersByKey = new Map<string, Set<() => void>>()

/** Persist key for attachments — mirrors hot composer draft run scoping. */
export function composerAttachmentKey(
  workspacePath: string | null | undefined,
  runId?: string | null
): string | null {
  if (!workspacePath) return null
  return `${workspacePath}::${runId ?? HOT_COMPOSER_DRAFT_KEY}`
}

function notify(key: string): void {
  const listeners = listenersByKey.get(key)
  if (listeners) {
    for (const listener of listeners) listener()
  }
}

export function getComposerAttachments(key: string | null | undefined): ComposerAttachmentState {
  if (!key) return EMPTY_ATTACHMENTS
  return byKey.get(key) ?? EMPTY_ATTACHMENTS
}

export function setComposerAttachments(
  key: string,
  patch: Partial<ComposerAttachmentState>
): void {
  const prev = byKey.get(key) ?? EMPTY_ATTACHMENTS
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
    byKey.has(key)
  ) {
    return
  }
  byKey.set(key, next)
  notify(key)
}

export function clearComposerAttachments(key: string): void {
  if (!byKey.has(key)) return
  byKey.delete(key)
  notify(key)
}

/** Drop every attachment bucket for a workspace (all run keys + legacy bare path). */
export function clearComposerAttachmentsForWorkspace(workspacePath: string): void {
  const prefix = `${workspacePath}::`
  const keys = [...byKey.keys()].filter((k) => k === workspacePath || k.startsWith(prefix))
  for (const key of keys) {
    byKey.delete(key)
    notify(key)
  }
}

export function subscribeComposerAttachments(
  key: string | null | undefined,
  listener: () => void
): () => void {
  if (!key) return () => {}
  let set = listenersByKey.get(key)
  if (!set) {
    set = new Set()
    listenersByKey.set(key, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listenersByKey.delete(key)
  }
}

/** Subscribe to one persist-key's composer attachments (no-op when unbound). */
export function useComposerAttachments(key: string | null | undefined): ComposerAttachmentState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeComposerAttachments(key, onStoreChange),
    [key]
  )
  const getSnapshot = useCallback(() => getComposerAttachments(key), [key])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Test helper — reset module state between cases. */
export function resetComposerAttachmentStoreForTests(): void {
  byKey.clear()
  listenersByKey.clear()
}
