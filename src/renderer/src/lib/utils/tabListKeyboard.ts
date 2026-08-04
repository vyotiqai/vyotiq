import type { KeyboardEvent } from 'react'

export function handleTabListKeyDown(
  event: KeyboardEvent,
  opts: {
    tabs: string[]
    activeId: string | null
    onSelect: (id: string) => void
  }
): void {
  const { tabs, activeId, onSelect } = opts
  if (tabs.length === 0) return

  const currentIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab === activeId)
  )
  let nextIndex = currentIndex

  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % tabs.length
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
  } else if (event.key === 'Home') {
    nextIndex = 0
  } else if (event.key === 'End') {
    nextIndex = tabs.length - 1
  } else {
    return
  }

  event.preventDefault()
  onSelect(tabs[nextIndex]!)
}
