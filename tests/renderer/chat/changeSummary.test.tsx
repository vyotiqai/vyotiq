/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ChangeSummary,
  COMPACT_PREVIEW_COUNT
} from '@renderer/features/chat/components/ChangeSummary'
import type { ChangedFile } from '@renderer/features/chat/utils/transcriptRows'

function files(count: number): ChangedFile[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `src/file-${String(i).padStart(2, '0')}.ts`,
    added: i + 1,
    removed: i
  }))
}

describe('ChangeSummary compact receipt', () => {
  it('shows Review, preview rows, and Show more without Keep/Discard', () => {
    const onOpenChanges = vi.fn()
    const list = files(COMPACT_PREVIEW_COUNT + 3)
    const { container } = render(
      <ChangeSummary files={list} compact onOpenChanges={onOpenChanges} />
    )

    expect(screen.getByText(`${list.length} Files Changed`)).toBeTruthy()
    expect(container.querySelector('[data-change-summary="receipt"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Keep all' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull()

    expect(screen.getByText('file-00.ts')).toBeTruthy()
    expect(screen.getByText(`file-0${COMPACT_PREVIEW_COUNT - 1}.ts`)).toBeTruthy()
    expect(screen.queryByText(`file-0${COMPACT_PREVIEW_COUNT}.ts`)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(onOpenChanges).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: `… Show 3 more` }))
    expect(screen.getByText(`file-0${COMPACT_PREVIEW_COUNT}.ts`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.queryByText(`file-0${COMPACT_PREVIEW_COUNT}.ts`)).toBeNull()
  })

  it('omits Show more when files fit the preview', () => {
    render(<ChangeSummary files={files(2)} compact onOpenChanges={() => undefined} />)
    expect(screen.queryByRole('button', { name: /Show .+ more/ })).toBeNull()
  })

  it('hides Review when onOpenChanges is missing', () => {
    render(<ChangeSummary files={files(1)} compact />)
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull()
  })
})

describe('ChangeSummary resolve mode', () => {
  it('keeps Keep/Discard when canResolve', () => {
    render(
      <ChangeSummary
        files={files(1)}
        canResolve
        onKeepAll={() => undefined}
        onDiscardAll={() => undefined}
        onKeepFile={() => undefined}
        onDiscardFile={() => undefined}
      />
    )
    expect(screen.getByRole('button', { name: 'Keep all' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Discard all' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep' })).toBeTruthy()
  })

  it('uses Changes-panel chrome matching the uncommitted file list', () => {
    const { container } = render(<ChangeSummary files={files(1)} canResolve />)
    const root = container.querySelector('[data-change-summary="panel"]')
    expect(root).toBeTruthy()
    expect(root?.className).toContain('rounded-md')
    expect(root?.className).toContain('border-border/50')
    expect(root?.className).toContain('bg-surface')
  })

  it('expands file diffs without a nested scroll viewport', () => {
    const diffs = new Map([
      [
        'src/file-00.ts',
        Array.from({ length: 40 }, (_, i) => ({
          kind: 'add' as const,
          text: `line ${i}`,
          lineNumber: i + 1
        }))
      ]
    ])
    const { container } = render(
      <ChangeSummary files={files(1)} fileDiffs={diffs} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show diff' }))
    expect(container.querySelector('[data-diff-preview="scroll"]')).toBeNull()
    expect(screen.getByText('line 0')).toBeTruthy()
  })
})
