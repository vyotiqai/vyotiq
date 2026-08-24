import { useEffect, useMemo, useRef, useState } from 'react'
import { shortcutCatalog, type ShortcutCatalogEntry } from '@renderer/lib/shortcuts'

export function CommandPalette({
  open,
  onClose,
  onSelect
}: {
  open: boolean
  onClose: () => void
  onSelect: (id: string) => void
}) {
  const entries = useMemo(() => shortcutCatalog(), [])
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    inputRef.current?.focus()
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (entry) =>
        entry.title.toLowerCase().includes(q) ||
        entry.label.toLowerCase().includes(q) ||
        entry.id.toLowerCase().includes(q)
    )
  }, [entries, query])

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  if (!open) return null

  const run = (entry: ShortcutCatalogEntry): void => {
    onSelect(entry.id)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 pt-[12vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="flex w-[min(32rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-lg"
        role="dialog"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          className="border-b border-border bg-transparent px-3 py-2 text-sm text-fg outline-none"
          placeholder="Search commands…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
              return
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setIndex((i) => Math.min(filtered.length - 1, i + 1))
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              const entry = filtered[index]
              if (entry) run(entry)
            }
          }}
        />
        <ul className="m-0 max-h-80 list-none overflow-auto p-1">
          {filtered.length === 0 ? (
            <li className="px-2 py-2 text-sm text-muted">No matching commands.</li>
          ) : (
            filtered.map((entry, i) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm ${
                    i === index ? 'bg-accent/15 text-fg' : 'text-fg hover:bg-surface-2'
                  }`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => run(entry)}
                >
                  <span>{entry.title}</span>
                  <span className="text-xs text-muted">{entry.label}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
