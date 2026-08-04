/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolCard } from '@renderer/features/chat/components/ToolCard'
import type { ToolItem } from '@renderer/features/chat/utils/transcriptRows'
import { TOOL_TERMINAL_VIEWPORT_MAX_PX } from '@renderer/lib/utils/layout'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
})

afterEach(() => {
  cleanup()
})

function editItem(status: 'running' | 'done' | 'fail'): ToolItem {
  return {
    kind: 'tool',
    id: 'e1',
    tool: {
      id: 'e1',
      name: 'edit',
      summary: 'src/a.ts',
      status,
      argsPreview: JSON.stringify({ path: 'src/a.ts', contents: 'hello\nworld\n' })
    }
  }
}

function terminalItem(
  status: 'running' | 'done' | 'fail',
  overrides?: Partial<ToolItem['tool']>,
  itemOverrides?: Partial<Pick<ToolItem, 'at' | 'groupTiming'>>
): ToolItem {
  return {
    kind: 'tool',
    id: 't1',
    tool: {
      id: 't1',
      name: 'terminal',
      summary: 'pnpm test',
      status,
      argsPreview: JSON.stringify({ command: 'pnpm test' }),
      presentation: 'prominent',
      content:
        status === 'running'
          ? 'line\n'.repeat(40)
          : 'cwd: /ws\nshell: powershell\n\nok\nexit_code: 0',
      ...overrides
    },
    ...itemOverrides
  }
}

describe('ToolCard live expand', () => {
  it('stays expanded after the tool finishes while the turn is live', () => {
    render(<ToolCard item={editItem('done')} live />)
    const toggle = screen.getByRole('button', { name: /Collapse Edited/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.mask-fade-bottom')).toBeNull()
  })

  it('folds to clamp when live clears and the tool is done', () => {
    const { rerender } = render(<ToolCard item={editItem('done')} live />)
    expect(screen.getByRole('button', { name: /Collapse Edited/i }).getAttribute('aria-expanded')).toBe(
      'true'
    )

    rerender(<ToolCard item={editItem('done')} live={false} />)
    expect(screen.getByRole('button', { name: /Expand Edited/i }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(document.querySelector('.mask-fade-bottom')).toBeTruthy()
  })

  it('honors an explicit collapsed toolExpanded while live', () => {
    render(<ToolCard item={editItem('done')} expanded={false} live />)
    expect(screen.getByRole('button', { name: /Expand Edited/i }).getAttribute('aria-expanded')).toBe(
      'false'
    )
  })
})

describe('ToolCard terminal fixed viewport', () => {
  it('keeps long streaming output inside a capped scroll viewport', () => {
    render(<ToolCard item={terminalItem('running')} live />)
    const viewport = screen.getByTestId('terminal-viewport')
    expect(viewport.className).toMatch(/max-h-/)
    expect(viewport.className).toMatch(/overflow-y-auto/)
    expect(screen.getByText('$ pnpm test')).toBeTruthy()
    // Many output lines must not remove the height cap.
    expect(viewport.textContent).toContain('line')
  })

  it('shows command + meta in the viewport before streams arrive', () => {
    render(
      <ToolCard
        item={terminalItem('running', {
          content: undefined,
          argsPreview: JSON.stringify({ command: 'Get-ChildItem' })
        })}
        live
      />
    )
    expect(screen.getByTestId('terminal-viewport')).toBeTruthy()
    expect(screen.getByText('$ Get-ChildItem')).toBeTruthy()
  })

  it('renders settled cwd/shell meta with dashed dividers and $ command', () => {
    render(<ToolCard item={terminalItem('done')} expanded />)
    const viewport = screen.getByTestId('terminal-viewport')
    expect(viewport.textContent).toContain('cwd: /ws')
    expect(viewport.textContent).toContain('shell: powershell')
    expect(viewport.textContent).toContain('---')
    expect(viewport.textContent).toContain('$ pnpm test')
    expect(viewport.textContent).toContain('ok')
  })

  it('prefers started_at / running_for_ms when ToolItem timing exists', () => {
    const startedAt = Date.parse('2026-08-01T09:02:08.030Z')
    render(
      <ToolCard
        item={terminalItem('done', undefined, {
          groupTiming: { startedAt, endedAt: startedAt + 580931 }
        })}
        expanded
      />
    )
    const viewport = screen.getByTestId('terminal-viewport')
    expect(viewport.textContent).toContain('started_at: 2026-08-01T09:02:08.030Z')
    expect(viewport.textContent).toContain('running_for_ms: 580931')
    // Timing replaces cwd/shell meta when available.
    expect(viewport.textContent).not.toContain('cwd: /ws')
    expect(viewport.getAttribute('role')).toBe('region')
    expect(viewport.getAttribute('aria-label')).toBe('Terminal output')
  })

  it('shows multi-line command as first line + N+ in the header secondary', () => {
    render(
      <ToolCard
        item={terminalItem('done', {
          argsPreview: JSON.stringify({ command: 'Get-ChildItem\nSelect-Object\nFormat-List' }),
          content: 'cwd: /ws\nshell: powershell\n\nok\nexit_code: 0'
        })}
        expanded
      />
    )
    expect(screen.getByText('Get-ChildItem, 2+')).toBeTruthy()
    expect(screen.getByText(/\$ Get-ChildItem/)).toBeTruthy()
  })

  it('auto-scrolls to the bottom while running when pinned', () => {
    const { rerender } = render(<ToolCard item={terminalItem('running', { content: 'a\n' })} live />)
    const viewport = screen.getByTestId('terminal-viewport')
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 800 })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 192 })
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => (viewport as HTMLElement & { _scrollTop?: number })._scrollTop ?? 0,
      set: (v: number) => {
        ;(viewport as HTMLElement & { _scrollTop?: number })._scrollTop = v
      }
    })

    rerender(
      <ToolCard item={terminalItem('running', { content: `${'line\n'.repeat(60)}` })} live />
    )
    expect(viewport.scrollTop).toBe(800)
  })

  it('stops auto-follow after the user scrolls up inside the viewport', () => {
    const { rerender } = render(
      <ToolCard item={terminalItem('running', { content: 'start\n' })} live />
    )
    const viewport = screen.getByTestId('terminal-viewport')
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 800 })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 192 })
    let scrollTop = 0
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v
      }
    })

    scrollTop = 10
    fireEvent.scroll(viewport)
    rerender(
      <ToolCard item={terminalItem('running', { content: `${'more\n'.repeat(40)}` })} live />
    )
    // Pinned latch cleared — effect must not force scrollTop to scrollHeight.
    expect(scrollTop).toBe(10)
  })

  it('keeps the viewport cap after the turn settles while still expanded', () => {
    render(<ToolCard item={terminalItem('done')} expanded />)
    const viewport = screen.getByTestId('terminal-viewport')
    expect(viewport.className).toMatch(/max-h-/)
    // Constant stays aligned with layout token used by the virtualizer.
    expect(TOOL_TERMINAL_VIEWPORT_MAX_PX).toBe(192)
  })
})
