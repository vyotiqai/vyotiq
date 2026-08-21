import type { CodeIndexEmbedderId, CodeIndexRuntimeStatus } from './types'

let status: CodeIndexRuntimeStatus = {
  phase: 'idle',
  modelId: '',
  embedder: 'mdenseon',
  progress: null,
  message: null,
  error: null,
  modelDir: null,
  indexProgress: null
}

const listeners = new Set<(s: CodeIndexRuntimeStatus) => void>()

export function getCodeIndexRuntimeStatus(): CodeIndexRuntimeStatus {
  return { ...status, indexProgress: status.indexProgress ? { ...status.indexProgress } : null }
}

export function setCodeIndexRuntimeStatus(partial: Partial<CodeIndexRuntimeStatus>): void {
  status = { ...status, ...partial }
  const snap = getCodeIndexRuntimeStatus()
  for (const fn of listeners) {
    try {
      fn(snap)
    } catch {
      /* ignore listener errors */
    }
  }
}

export function resetCodeIndexRuntimeStatusForTests(): void {
  status = {
    phase: 'idle',
    modelId: '',
    embedder: 'mdenseon',
    progress: null,
    message: null,
    error: null,
    modelDir: null,
    indexProgress: null
  }
  listeners.clear()
}

export function onCodeIndexRuntimeStatus(
  fn: (s: CodeIndexRuntimeStatus) => void
): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function markCodeIndexEmbedder(embedder: CodeIndexEmbedderId): void {
  setCodeIndexRuntimeStatus({ embedder })
}
