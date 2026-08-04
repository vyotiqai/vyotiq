/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import {
  ChangedFilesBrowser,
  type BrowserFileEntry
} from '@renderer/features/chat/components/ChangedFilesBrowser'

function entry(
  path: string,
  overrides: Partial<BrowserFileEntry> = {}
): BrowserFileEntry {
  return {
    path,
    statusLetter: 'M',
    statusLabel: 'Modified',
    added: 1,
    removed: 0,
    ...overrides
  }
}

beforeEach(() => {
  class ImmediateIntersectionObserver {
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds = []
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [
          {
            isIntersecting: true,
            target,
            intersectionRatio: 1,
            time: 0,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRect: target.getBoundingClientRect(),
            rootBounds: null
          }
        ],
        this as unknown as IntersectionObserver
      )
    }
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ChangedFilesBrowser', () => {
  it('renders a single-column list with inline expandable diffs', async () => {
    const fetchDiff = vi.fn().mockResolvedValue({
      content: ['@@ -1,1 +1,2 @@', ' keep', '+added-line'].join('\n')
    })

    render(
      <div style={{ height: 480 }}>
        <ChangedFilesBrowser
          className="h-full"
          files={[
            entry('hooks/skills/a/SKILL.md', {
              statusLetter: 'A',
              statusLabel: 'New',
              added: 2
            }),
            entry('hooks/skills/b/SKILL.md', {
              statusLetter: 'A',
              statusLabel: 'New',
              added: 3
            })
          ]}
          expanded={new Set(['hooks/skills/a/SKILL.md'])}
          onToggleExpand={() => undefined}
          selectedPath="hooks/skills/a/SKILL.md"
          onSelectPath={() => undefined}
          fetchDiff={fetchDiff}
          layout="unified"
          wordWrap={false}
          findQuery=""
        />
      </div>
    )

    await waitFor(() => {
      expect(screen.getByText('added-line')).toBeTruthy()
    })

    expect(fetchDiff).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText('added-line')).toHaveLength(1)
    expect(screen.queryByText('Tree')).toBeNull()
    expect(screen.getByText('hooks/skills/a/')).toBeTruthy()
    expect(screen.getByText('hooks/skills/b/')).toBeTruthy()
  })

  it('does not render empty-diff sentinels as fake diff lines', async () => {
    const fetchDiff = vi.fn().mockResolvedValue({ content: '(no unstaged changes)' })

    render(
      <ChangedFilesBrowser
        files={[entry('new.md', { statusLetter: 'A', statusLabel: 'New', added: 10 })]}
        expanded={new Set(['new.md'])}
        onToggleExpand={() => undefined}
        selectedPath="new.md"
        onSelectPath={() => undefined}
        fetchDiff={fetchDiff}
        layout="unified"
        wordWrap={false}
        findQuery=""
      />
    )

    await waitFor(() => {
      expect(screen.getByText('No textual diff')).toBeTruthy()
    })
    expect(screen.queryByText('(no unstaged changes)')).toBeNull()
  })
})
