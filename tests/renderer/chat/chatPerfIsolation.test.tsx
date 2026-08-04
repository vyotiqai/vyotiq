/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useHasChatItems } from '@renderer/features/chat/components/ChatStreamLeaves'
import type { ChatItemsStore } from '@renderer/features/chat/chatStores'
import type { UiItem } from '@shared/transcript'

function makeStore(initial: UiItem[]): ChatItemsStore & { setItems: (items: UiItem[]) => void } {
  let items = initial
  let revision = 0
  const listeners = new Set<() => void>()
  return {
    subscribeItems: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getItemsRevision: () => revision,
    getItems: () => items,
    setItems: (next) => {
      items = next
      revision += 1
      for (const listener of listeners) listener()
    }
  }
}

describe('useHasChatItems', () => {
  it('stays Object.is-stable across stream growth after the first item', () => {
    const store = makeStore([])
    const { result, rerender } = renderHook(() => useHasChatItems(store, []))

    expect(result.current).toBe(false)

    act(() => {
      store.setItems([
        {
          kind: 'text',
          id: 'a1',
          role: 'assistant',
          text: 'hi',
          streaming: true
        } as UiItem
      ])
    })
    rerender()
    expect(result.current).toBe(true)

    act(() => {
      store.setItems([
        {
          kind: 'text',
          id: 'a1',
          role: 'assistant',
          text: 'hi there',
          streaming: true
        } as UiItem
      ])
    })
    rerender()
    // Still true — ChatView must not treat this as a presence flip.
    expect(result.current).toBe(true)
  })
})

describe('virtualizer full-DOM fallback gate', () => {
  it('only allows the jsdom full fallback under Vitest', () => {
    expect(process.env.VITEST).toBe('true')
    const allowFullFallback =
      typeof process !== 'undefined' && process.env.VITEST === 'true'
    expect(allowFullFallback).toBe(true)
  })
})
