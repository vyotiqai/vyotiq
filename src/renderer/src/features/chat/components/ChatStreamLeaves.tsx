import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import type { UiItem } from '@shared/transcript'
import { GitBranchStrip, GitChangePills, type GitChrome } from './GitChrome'
import type { ChatItemsStore } from '../chatStores'

/** Bumps on workspace change, run end, and (debounced) mid-run mutating tool results. */
const MUTATING_GIT_TOOLS = new Set([
  'edit',
  'multi_edit',
  'str_replace',
  'delete',
  'terminal',
  'memory_write',
  'git_commit'
])

export function useGitRevision(
  workspacePath: string | null,
  running: boolean,
  items: UiItem[]
): [number, () => void] {
  const [revision, setRevision] = useState(0)
  const bump = useCallback(() => {
    setRevision((value) => value + 1)
  }, [])
  const wasRunning = useRef(running)
  const mutatingDoneCount = useRef(0)
  /** Skip the mount bump — useGitStatus already fetches once for the initial path. */
  const prevPathRef = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (wasRunning.current && !running) setRevision((value) => value + 1)
    if (!wasRunning.current && running) mutatingDoneCount.current = 0
    wasRunning.current = running
  }, [running])

  useEffect(() => {
    if (prevPathRef.current === undefined) {
      prevPathRef.current = workspacePath
      return
    }
    if (prevPathRef.current === workspacePath) return
    prevPathRef.current = workspacePath
    setRevision((value) => value + 1)
  }, [workspacePath])

  useEffect(() => {
    if (!running) return
    let count = 0
    for (const item of items) {
      if (item.kind !== 'tool') continue
      if (item.tool.status !== 'done' && item.tool.status !== 'fail') continue
      if (MUTATING_GIT_TOOLS.has(item.tool.name)) count++
    }
    if (count <= mutatingDoneCount.current) return
    mutatingDoneCount.current = count
    const timer = window.setTimeout(() => {
      setRevision((value) => value + 1)
    }, 400)
    return () => window.clearTimeout(timer)
  }, [items, running])

  return [revision, bump]
}

function useLiveItems(itemsStore: ChatItemsStore | undefined, items: UiItem[]): UiItem[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => itemsStore?.subscribeItems(onStoreChange) ?? (() => {}),
    [itemsStore]
  )
  const getRevision = useCallback(
    () => itemsStore?.getItemsRevision() ?? 0,
    [itemsStore]
  )
  useSyncExternalStore(subscribe, getRevision, getRevision)
  return itemsStore ? itemsStore.getItems() : items
}

/**
 * Boolean-only items presence — Object.is-stable across pure stream deltas so
 * ChatView / Composer skip re-renders while the transcript grows.
 */
export function useHasChatItems(
  itemsStore: ChatItemsStore | undefined,
  items: UiItem[]
): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => itemsStore?.subscribeItems(onStoreChange) ?? (() => {}),
    [itemsStore]
  )
  const getSnapshot = useCallback((): boolean => {
    const list = itemsStore ? itemsStore.getItems() : items
    return list.length > 0
  }, [itemsStore, items])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useChatLiveItems(
  itemsStore: ChatItemsStore | undefined,
  items: UiItem[]
): UiItem[] {
  return useLiveItems(itemsStore, items)
}

/** Changes pills left, branch + refresh right — one leading chrome row. */
export function ChatGitLeading({
  chrome,
  onOpenChanges
}: {
  chrome: GitChrome
  onOpenChanges?: () => void
}): ReactNode {
  return (
    <div className="flex w-full items-center gap-2">
      <div className="min-w-0 flex-1">
        <GitChangePills chrome={chrome} onOpenChanges={onOpenChanges} />
      </div>
      <GitBranchStrip chrome={chrome} />
    </div>
  )
}

/** @deprecated Branch strip lives in ChatGitLeading; keep for callers that still pass trailing. */
export function ChatGitTrailing(_props: { chrome: GitChrome }): ReactNode {
  return null
}
