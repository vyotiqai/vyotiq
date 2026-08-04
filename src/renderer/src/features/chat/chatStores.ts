import type { UiItem } from '@shared/transcript'
import type { ContextUsageState } from '@shared/utils/contextUsage'

/** Items stream — ChatView must not subscribe; only TranscriptPane / git leaves. */
export type ChatItemsStore = {
  subscribeItems: (listener: () => void) => () => void
  getItemsRevision: () => number
  getItems: () => UiItem[]
}

/**
 * Meta stream for meter / coarse flags. Snapshots must stay Object.is-stable
 * when the underlying value is unchanged (React useSyncExternalStore).
 */
export type ChatMetaStore = {
  subscribeMeta: (listener: () => void) => () => void
  getMetaRevision: () => number
  getContextUsage: () => ContextUsageState | null
}
