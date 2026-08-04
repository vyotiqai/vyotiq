import { useCallback, useSyncExternalStore } from 'react'

/**
 * Narrow external store for keystroke-hot workspace UI (composer draft + session search).
 * Keeps App/`setContexts` off the typing path while persistence still reads `contextsRef`.
 */

export type WorkspaceHotUi = {
  composerDraft: string
  sessionQuery: string
}

const EMPTY_HOT_UI: WorkspaceHotUi = Object.freeze({
  composerDraft: '',
  sessionQuery: ''
})

const byPath = new Map<string, WorkspaceHotUi>()
const listenersByPath = new Map<string, Set<() => void>>()
let globalRevision = 0
const globalListeners = new Set<() => void>()

function notify(path: string): void {
  globalRevision += 1
  const pathListeners = listenersByPath.get(path)
  if (pathListeners) {
    for (const listener of pathListeners) listener()
  }
  for (const listener of globalListeners) listener()
}

export function getWorkspaceHotUi(path: string | null | undefined): WorkspaceHotUi {
  if (!path) return EMPTY_HOT_UI
  return byPath.get(path) ?? EMPTY_HOT_UI
}

export function hasWorkspaceHotUi(path: string): boolean {
  return byPath.has(path)
}

export function getWorkspaceHotUiRevision(): number {
  return globalRevision
}

export function subscribeWorkspaceHotUi(
  path: string | null | undefined,
  listener: () => void
): () => void {
  if (!path) {
    globalListeners.add(listener)
    return () => {
      globalListeners.delete(listener)
    }
  }
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

export function setWorkspaceHotUi(
  path: string,
  patch: Partial<WorkspaceHotUi>
): WorkspaceHotUi {
  const prev = byPath.get(path) ?? { composerDraft: '', sessionQuery: '' }
  const next: WorkspaceHotUi = {
    composerDraft:
      patch.composerDraft !== undefined ? patch.composerDraft : prev.composerDraft,
    sessionQuery:
      patch.sessionQuery !== undefined ? patch.sessionQuery : prev.sessionQuery
  }
  if (
    next.composerDraft === prev.composerDraft &&
    next.sessionQuery === prev.sessionQuery &&
    byPath.has(path)
  ) {
    return prev
  }
  byPath.set(path, next)
  notify(path)
  return next
}

export function seedWorkspaceHotUi(path: string, values: WorkspaceHotUi): void {
  const prev = byPath.get(path)
  if (
    prev &&
    prev.composerDraft === values.composerDraft &&
    prev.sessionQuery === values.sessionQuery
  ) {
    return
  }
  byPath.set(path, {
    composerDraft: values.composerDraft,
    sessionQuery: values.sessionQuery
  })
  notify(path)
}

export function clearWorkspaceHotUi(path: string): void {
  if (!byPath.has(path)) return
  byPath.delete(path)
  notify(path)
}

/** Subscribe a leaf component to hot UI for one workspace (does not re-render parents). */
export function useWorkspaceHotUi(path: string | null | undefined): WorkspaceHotUi {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeWorkspaceHotUi(path, onStoreChange),
    [path]
  )
  const getSnapshot = useCallback(() => getWorkspaceHotUi(path), [path])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Test helper — reset module state between cases. */
export function resetWorkspaceHotUiStoreForTests(): void {
  byPath.clear()
  listenersByPath.clear()
  globalListeners.clear()
  globalRevision = 0
}
