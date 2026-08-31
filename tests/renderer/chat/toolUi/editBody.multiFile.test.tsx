/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MultiEditBody } from '@renderer/features/chat/toolUi/bodies/EditBody'
import type { UiToolRow } from '@shared/transcript'

// Keep shiki out of the render path (same precedent as diffPreview.test.tsx):
// the multi-file layout under characterization does not depend on token colours.
vi.mock('@renderer/lib/markdown/markdownHighlight', () => ({
  highlightToLines: vi.fn(() => Promise.resolve(null)),
  languageFromPath: (path: string) => (path.endsWith('.ts') ? 'typescript' : null)
}))

function multiEditRow(): UiToolRow {
  return {
    id: 'me-multi',
    name: 'multi_edit',
    summary: 'src/a.ts, src/b.ts',
    status: 'done',
    content: 'Applied 2 edits:\n- wrote src/a.ts\n- patched src/b.ts',
    argsPreview: JSON.stringify({
      edits: [
        { path: 'src/a.ts', contents: 'A\n' },
        { path: 'src/b.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }
      ]
    })
  }
}

describe('MultiEditBody', () => {
  it('renders one diff section per file for a done multi_edit batch', () => {
    const row = multiEditRow()
    const { container } = render(
      <MultiEditBody tool={row} expanded loading={false} loadFailed={false} />
    )

    // Each file gets its own path header row in the diff preview.
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('src/b.ts')).toBeTruthy()

    // Both files' change lines render under their headers:
    // a.ts writes contents, b.ts applies a unified diff.
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('old')).toBeTruthy()
    expect(screen.getByText('new')).toBeTruthy()

    // Everything landed in the card body (not just the collapsed summary).
    const text = container.textContent ?? ''
    expect(text).toContain('src/a.ts')
    expect(text).toContain('src/b.ts')
    expect(text).toContain('A')
    expect(text).toContain('old')
    expect(text).toContain('new')

    // Sections stay in argument order: a.ts's section precedes b.ts's.
    expect(text.indexOf('src/a.ts')).toBeLessThan(text.indexOf('src/b.ts'))
  })
})
