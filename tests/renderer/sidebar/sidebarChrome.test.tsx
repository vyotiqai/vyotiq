/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar } from '@renderer/app/sidebar'
import { createRef } from 'react'

const searchRef = createRef<HTMLInputElement>()

const baseProps = {
  view: 'chat' as const,
  sessionQuery: '',
  searchRef,
  hasWorkspace: true,
  openPaths: ['/ws/demo'],
  activePath: '/ws/demo',
  runsByWorkspacePath: {
    '/ws/demo': {
      runs: [],
      runsCapped: false,
      runsError: null,
      runsLoaded: true,
      activeRunId: null
    }
  },
  activeRuns: [],
  onSessionQuery: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenMarketplace: vi.fn(),
  onOpenChat: vi.fn(),
  onNewChat: vi.fn(),
  onSelectRunInWorkspace: vi.fn(),
  onRenameRunInWorkspace: vi.fn(),
  onDeleteRunInWorkspace: vi.fn(),
  onCloseDrawer: vi.fn(),
  onToggleSidebar: vi.fn(),
  onSwitchWorkspace: vi.fn(),
  onCloseWorkspace: vi.fn(),
  onAddWorkspace: vi.fn(),
  workspaceHasBackgroundRun: () => false
}

beforeEach(() => {
  // @ts-expect-error test bridge
  window.vyotiq = { platform: 'win32' }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Sidebar chrome', () => {
  it('disables search and new chat when no workspace is open', () => {
    render(
      <Sidebar
        {...baseProps}
        hasWorkspace={false}
        openPaths={[]}
        activePath={null}
        runsByWorkspacePath={{}}
      />
    )

    expect((screen.getByRole('textbox', { name: /search chats/i }) as HTMLInputElement).disabled).toBe(
      true
    )
    expect((screen.getByRole('button', { name: /new chat/i }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect((screen.getByRole('button', { name: /^settings$/i }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it('highlights the active footer nav item', () => {
    const { rerender } = render(<Sidebar {...baseProps} view="chat" />)

    expect(screen.getByRole('button', { name: /^settings$/i }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('button', { name: /^marketplace$/i }).getAttribute('aria-current')).toBeNull()

    rerender(<Sidebar {...baseProps} view="settings" />)
    expect(screen.getByRole('button', { name: /^settings$/i }).getAttribute('aria-current')).toBe(
      'page'
    )

    rerender(<Sidebar {...baseProps} view="marketplace" />)
    expect(screen.getByRole('button', { name: /^marketplace$/i }).getAttribute('aria-current')).toBe(
      'page'
    )
  })

  it('calls onNewChat from the header button', () => {
    const onNewChat = vi.fn()
    render(<Sidebar {...baseProps} onNewChat={onNewChat} />)

    fireEvent.click(screen.getByRole('button', { name: /new chat/i }))
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('calls onOpenSettings from the footer', () => {
    const onOpenSettings = vi.fn()
    render(<Sidebar {...baseProps} onOpenSettings={onOpenSettings} />)

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })
})
