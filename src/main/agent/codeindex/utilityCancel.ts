/** Bounded set of cancelled utility request ids (queued + active). */

export function createCancelledIdSet(maxSize = 256): {
  remember: (id: number) => void
  consume: (id: number) => boolean
  has: (id: number) => boolean
  clear: () => void
  size: () => number
} {
  const ids = new Set<number>()
  return {
    remember(id: number): void {
      ids.add(id)
      if (ids.size <= maxSize) return
      const first = ids.values().next().value
      if (first != null) ids.delete(first)
    },
    consume(id: number): boolean {
      return ids.delete(id)
    },
    has(id: number): boolean {
      return ids.has(id)
    },
    clear(): void {
      ids.clear()
    },
    size(): number {
      return ids.size
    }
  }
}
