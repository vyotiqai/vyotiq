/** Backoff / stall detection for incomplete index warm pages. */

export const INDEX_WARM_BACKOFF_MS = [2_000, 5_000, 30_000] as const
/** Stall after this many no-progress repeats (second identical fingerprint). */
export const INDEX_WARM_STALL_LIMIT = 1

export type WarmProgressSample = {
  codeScanned?: number
  codeIndexed?: number
  codeComplete?: boolean
  codeCursor?: string | null
  sparseScanned?: number
  sparseIndexed?: number
  sparseComplete?: boolean
  sparseCursor?: string | null
}

export type WarmPagingState = {
  key: string
  stallCount: number
  backoffMs: number
}

export function warmProgressKey(sample: WarmProgressSample): string {
  return [
    sample.codeScanned ?? 0,
    sample.codeIndexed ?? 0,
    sample.codeComplete === true ? 1 : 0,
    sample.codeCursor ?? '',
    sample.sparseScanned ?? 0,
    sample.sparseIndexed ?? 0,
    sample.sparseComplete === true ? 1 : 0,
    sample.sparseCursor ?? ''
  ].join('|')
}

export function nextWarmBackoffMs(prevMs: number | undefined): number {
  if (prevMs == null || prevMs < INDEX_WARM_BACKOFF_MS[0]) return INDEX_WARM_BACKOFF_MS[0]
  if (prevMs < INDEX_WARM_BACKOFF_MS[1]) return INDEX_WARM_BACKOFF_MS[1]
  return INDEX_WARM_BACKOFF_MS[2]
}

export function advanceWarmPagingState(
  prev: WarmPagingState | undefined,
  nextKey: string
): WarmPagingState & { stalled: boolean } {
  const same = prev?.key === nextKey
  const stallCount = same ? (prev?.stallCount ?? 0) + 1 : 0
  const backoffMs = same ? nextWarmBackoffMs(prev?.backoffMs) : INDEX_WARM_BACKOFF_MS[0]
  return {
    key: nextKey,
    stallCount,
    backoffMs,
    stalled: stallCount >= INDEX_WARM_STALL_LIMIT
  }
}
