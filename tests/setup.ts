import { afterEach, vi } from 'vitest'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'

/** jsdom/Node sometimes exposes a broken localStorage — ensure a working Map-backed stub. */
function ensureLocalStorage(): void {
  if (typeof globalThis === 'undefined') return
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return store.size
    },
    clear: () => {
      store.clear()
    },
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value))
    }
  }
  const needsStub =
    typeof globalThis.localStorage === 'undefined' ||
    typeof globalThis.localStorage?.setItem !== 'function' ||
    typeof globalThis.localStorage?.removeItem !== 'function'
  if (!needsStub) return
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage
  })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      writable: true,
      value: storage
    })
  }
}

ensureLocalStorage()

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })
  })
}

// `globals: false` means Testing Library never registers its own auto-cleanup, so
// rendered trees would stay mounted for the rest of the file and their timers can
// outlive the environment.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  afterEach(cleanup)
}

afterEach(() => {
  resetActiveRunsForTests()
  vi.clearAllMocks()
})
