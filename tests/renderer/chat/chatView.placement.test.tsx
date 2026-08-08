/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatView } from '@renderer/features/chat/ChatView'
import { TitleBar } from '@renderer/app/TitleBar'
import { BreakpointProvider } from '@renderer/lib/context/BreakpointProvider'
import { TitleBarAccessoryProvider } from '@renderer/lib/context/TitleBarAccessory'
import { clampDockWidthPx, DOCK_WIDTH_DEFAULT_PX, readSidebarWidthPxForCapacity } from '@renderer/lib/utils/layout'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  try {
    localStorage.removeItem('vyotiq.browserPanelOpen')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserRecents')
    localStorage.removeItem('vyotiq.dockExpanded')
    localStorage.removeItem('vyotiq.immersiveTab')
    localStorage.removeItem('vyotiq.dockWidth')
    localStorage.removeItem('vyotiq.sidebarWidth')
  } catch {
    /* ignore */
  }
  // The docked composer asks the main process about git as soon as it mounts.
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } }),
      gitDiff: vi.fn().mockResolvedValue({ ok: true, data: { path: '', hunks: [] } }),
      gitCommit: vi.fn().mockResolvedValue({ ok: true, data: { pushed: false, detail: 'ok' } }),
      gitLog: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      gitCommitFiles: vi.fn().mockResolvedValue({ ok: true, data: { files: [] } }),
      prView: vi.fn().mockResolvedValue({ ok: true, data: null }),
      prMerge: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'merged' } }),
      prDiff: vi.fn().mockResolvedValue({ ok: true, data: { content: '' } }),
      prClose: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'closed' } }),
      prEditTitle: vi.fn().mockResolvedValue({ ok: true, data: { title: 't' } }),
      githubAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          ghAvailable: true,
          clientIdConfigured: false,
          hasAppToken: false,
          pending: false,
          userCode: null,
          verificationUri: null,
          error: null
        }
      }),
      shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: true }),
      gitStageAll: vi.fn().mockResolvedValue({ ok: true, data: { staged: true, detail: 'ok' } }),
      gitStagePaths: vi.fn().mockResolvedValue({ ok: true, data: { staged: true, detail: 'ok' } }),
      gitUnstagePaths: vi.fn().mockResolvedValue({
        ok: true,
        data: { unstaged: true, detail: 'ok' }
      }),
      gitBranches: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      gitCheckout: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'ok' } }),
      ptyList: vi.fn().mockImplementation((_workspacePath?: string) =>
        Promise.resolve({ ok: true, data: [] })
      ),
      ptyCreate: vi.fn().mockResolvedValue({ ok: false, error: 'pty unavailable in tests' }),
      ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
      ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
      ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
      onPtyData: vi.fn().mockReturnValue(() => undefined),
      onPtyExit: vi.fn().mockReturnValue(() => undefined),
      readRunArtifact: vi.fn().mockResolvedValue({ ok: false, error: 'none' }),
      browserGetState: vi.fn().mockResolvedValue({
        ok: true,
        data: { open: false, url: '', title: '' }
      }),
      onBrowserState: vi.fn().mockReturnValue(() => undefined),
      browserSetBounds: vi.fn().mockResolvedValue({ ok: true, data: true }),
      browserNavigate: vi.fn().mockResolvedValue({ ok: true, data: true }),
      browserReload: vi.fn().mockResolvedValue({ ok: true, data: true }),
      browserTakeScreenshot: vi.fn().mockResolvedValue({
        ok: true,
        data: { path: '/tmp/snapshot.jpg' }
      }),
      browserClearBrowsingData: vi.fn().mockResolvedValue({
        ok: true,
        data: { cleared: 'history' }
      })
    }
  })
  class ResizeObserverStub {
    private readonly cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb
    }
    observe(): void {
      this.cb([], this as unknown as ResizeObserver)
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const baseProps = {
  items: [],
  running: false,
  error: null,
  hasWorkspace: true,
  workspacePath: '/ws',
  provider: 'ollama' as const,
  model: 'qwen2.5',
  activeRunId: null,
  chatSettings: {
    provider: 'ollama' as const,
    model: 'qwen2.5',
    compactionTriggerRatio: 0.7,
    keepRecentTurns: 12,
    thinkingEnabled: true,
    thinkingEffort: 'medium' as const,
    showThinking: true
  },
  onChatSettingsChange: vi.fn(),
  onProviderModel: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn()
}

describe('ChatView composer placement', () => {
  it('shows a side rail that opens the browser panel', () => {
    render(<ChatView {...baseProps} items={[]} />)

    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Show browser panel/i }))
    expect(document.querySelector('[data-agent-browser-panel]')).toBeTruthy()
    expect(document.querySelector('[data-agent-browser-viewport]')).toBeTruthy()
    // Dock open ? side rail hidden; dock tabs own navigation.
    expect(document.querySelector('[data-chat-side-rail]')).toBeNull()
    expect(screen.getByText('No page loaded')).toBeTruthy()
    expect(
      screen.getByText(/Enter a URL above, or ask the agent to open a page/i)
    ).toBeTruthy()
    const browserPanel = document.querySelector('[data-agent-browser-panel]')
    expect(
      browserPanel?.querySelector('[aria-label="Hide browser panel"]')
    ).toBeNull()
    expect(screen.getByRole('button', { name: /Close Browser/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Close panel/i })).toBeNull()
    expect(screen.getByPlaceholderText('Search or enter URL')).toBeTruthy()
  })

  it('closes one dock tab without clearing the remaining tabs', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /Add panel/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Changes/i }))
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(document.querySelector('[data-changes-panel]')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Terminal$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Changes$/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Close Changes/i }))
    expect(document.querySelector('[data-right-dock]')).toBeTruthy()
    expect(document.querySelector('[data-changes-panel]')).toBeNull()
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Terminal$/i })).toBeTruthy()
  })

  it('switches docked panels from the side rail', async () => {
    render(<ChatView {...baseProps} items={[]} />)

    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(document.querySelector('[data-chat-side-rail]')).toBeNull()
    expect(screen.getByText('No terminal')).toBeTruthy()
    // Session strip: New terminal only until a session exists; expand lives on DockTabBar.
    expect(screen.getByRole('button', { name: /New terminal/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /terminal list/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Maximize terminal/i })).toBeNull()
    expect(screen.queryByText(/Agent commands/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Split terminal/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Expand panel/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add panel/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Add panel/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Changes/i }))
    expect(document.querySelector('[data-changes-panel]')).toBeTruthy()
    // Keep-alive: prior panels stay mounted but hidden.
    expect(
      document.querySelector('[data-terminal-panel]')?.parentElement?.className
    ).toMatch(/\bhidden\b/)
    expect(
      document.querySelector('[data-changes-panel]')?.parentElement?.className
    ).toMatch(/\bflex\b/)
    expect(await screen.findByText('Not a git repository', {}, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /files panel/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Close Changes/i }))
    // Closing Changes via the tab leaves Terminal mounted.
    expect(document.querySelector('[data-changes-panel]')).toBeNull()
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(document.querySelector('[data-right-dock]')).toBeTruthy()
  })

  it('does not auto-open Browser on IPC rising edge', async () => {
    let browserHandler: ((state: { open: boolean; url: string; title: string }) => void) | null =
      null
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: { open: false, url: '', title: '' }
        }),
        onBrowserState: vi.fn((handler: typeof browserHandler) => {
          browserHandler = handler
          return () => {
            browserHandler = null
          }
        })
      }
    })

    render(<ChatView {...baseProps} items={[]} />)
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()

    browserHandler?.({ open: true, url: 'https://example.com', title: 'Example' })
    await Promise.resolve()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()
  })

  it('does not auto-open Browser when Terminal is already open', () => {
    let browserHandler: ((state: { open: boolean; url: string; title: string }) => void) | null =
      null
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: { open: true, url: 'https://example.com', title: 'Example' }
        }),
        onBrowserState: vi.fn((handler: typeof browserHandler) => {
          browserHandler = handler
          return () => {
            browserHandler = null
          }
        })
      }
    })

    localStorage.setItem('vyotiq.rightPanel', 'terminal')
    render(<ChatView {...baseProps} items={[]} />)

    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()

    browserHandler?.({ open: true, url: 'https://example.com/x', title: 'Example' })
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()
  })

  it('restores the Plan panel from localStorage on mount', () => {
    localStorage.setItem('vyotiq.rightPanel', 'plan')
    render(<ChatView {...baseProps} items={[]} />)

    expect(document.querySelector('[data-plan-panel]')).toBeTruthy()
    expect(document.querySelector('[data-chat-side-rail]')).toBeNull()
    expect(screen.getByRole('tab', { name: /^Plan$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Close Plan/i })).toBeTruthy()
  })

  it('does not auto-open Browser over a restored Plan panel', () => {
    let browserHandler: ((state: { open: boolean; url: string; title: string }) => void) | null =
      null
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: { open: false, url: '', title: '' }
        }),
        onBrowserState: vi.fn((handler: typeof browserHandler) => {
          browserHandler = handler
          return () => {
            browserHandler = null
          }
        })
      }
    })

    localStorage.setItem('vyotiq.rightPanel', 'plan')
    render(<ChatView {...baseProps} items={[]} />)

    expect(document.querySelector('[data-plan-panel]')).toBeTruthy()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()

    browserHandler?.({ open: true, url: 'https://example.com', title: 'Example' })
    expect(document.querySelector('[data-plan-panel]')).toBeTruthy()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()
  })

  it('does not auto-open Terminal when an agent terminal tool is running', () => {
    render(
      <ChatView
        {...baseProps}
        running
        items={[
          {
            kind: 'tool',
            id: 't1',
            tool: {
              id: 't1',
              name: 'terminal',
              summary: 'echo hi',
              status: 'running',
              argsPreview: '{"command":"echo hi"}'
            }
          }
        ]}
      />
    )
    expect(document.querySelector('[data-terminal-panel]')).toBeNull()
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()
  })

  it('does not auto-open Changes for unresolved writes or dirty git', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        gitStatus: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            kind: 'ok',
            status: {
              branch: 'main',
              files: [
                {
                  path: 'a.ts',
                  status: 'modified',
                  added: 1,
                  removed: 0,
                  addedStaged: 0,
                  removedStaged: 0,
                  addedUnstaged: 1,
                  removedUnstaged: 0,
                  binary: false,
                  staged: false,
                  unstaged: true
                }
              ],
              truncated: false,
              fileCount: 1,
              added: 1,
              removed: 0,
              hasRemote: true,
              hasCommits: true
            }
          }
        })
      }
    })

    render(
      <ChatView
        {...baseProps}
        canUndoWrites
        writeResolvablePaths={new Set(['a.ts'])}
      />
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelector('[data-changes-panel]')).toBeNull()
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /Add panel/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Changes/i }))
    expect(document.querySelector('[data-changes-panel]')).toBeTruthy()
  })

  it('auto-opens Plan when plan.md is ready in plan mode', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        readRunArtifact: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            exists: true,
            content: '# Plan\n\n1. Do the thing\n',
            path: '/ws/.vyotiq/runs/run-1/plan.md'
          }
        })
      }
    })

    render(
      <ChatView
        {...baseProps}
        agentMode="plan"
        activeRunId="run-1"
        running
        items={[]}
      />
    )

    expect(await screen.findByRole('tab', { name: /^Plan$/i })).toBeTruthy()
    expect(document.querySelector('[data-plan-panel]')).toBeTruthy()
  })

  it('shows Recents in the empty browser panel when history exists', () => {
    localStorage.setItem(
      'vyotiq.browserRecents',
      JSON.stringify([
        {
          url: 'https://example.com',
          title: 'Example Domain',
          visitedAt: Date.now()
        }
      ])
    )
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show browser panel/i }))
    expect(screen.getByText('Recents')).toBeTruthy()
    expect(screen.getByText('Example Domain')).toBeTruthy()
  })

  it('renders a single hero composer in empty state without dock gutter', () => {
    render(<ChatView {...baseProps} items={[]} />)

    const composers = screen.getAllByRole('textbox', { name: /^Message$/i })
    expect(composers).toHaveLength(1)

    expect(document.querySelector('[data-composer-hero]')).toBeTruthy()
    expect(screen.queryByText(/Type \/ for commands/i)).toBeNull()

    const composerRoot = composers[0].closest('.shrink-0')
    expect(composerRoot?.className).not.toMatch(/px-4/)
    expect(composerRoot?.className).not.toMatch(/sticky/)
  })

  it('renders a floating edge rail over the chat stage', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )

    const rail = document.querySelector('[data-chat-side-rail]')
    expect(rail?.className).toMatch(/absolute/)
    expect(rail?.className).toMatch(/right-0/)
    expect(document.querySelector('[data-composer-dock]')?.className).toMatch(/pr-10/)
    expect(document.querySelector('[data-transcript-scroll]')?.className).toMatch(/pr-10/)
  })

  it('keeps open right panels without reserving side-rail padding', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Show plan panel/i }))
    const dock = document.querySelector('[data-right-dock]')
    expect(dock?.className).not.toMatch(/pr-10/)
    expect(dock?.className).toMatch(/min-w-0/)
    expect(document.querySelector('[data-chat-side-rail]')).toBeNull()
    expect(document.querySelector('[data-dock-tab-bar]')).toBeTruthy()
    expect(document.querySelector('[data-plan-panel]')).toBeTruthy()
    // Agent column must drop rail inset once the floating rail is hidden.
    expect(document.querySelector('[data-composer-dock]')?.className).not.toMatch(/pr-10/)
    expect(document.querySelector('[data-transcript-scroll]')?.className).not.toMatch(/pr-10/)
  })

  it('centers the hero composer with symmetric gutter and column', () => {
    render(<ChatView {...baseProps} items={[]} />)

    const hero = document.querySelector('[role="status"]')
    expect(hero?.className).toMatch(/px-4/)
    expect(hero?.className).not.toMatch(/pr-10/)

    const heroColumn = document.querySelector('[data-composer-hero]')
    expect(heroColumn?.className).toMatch(/mx-auto/)
    expect(heroColumn?.className).toMatch(/max-w-\[840px\]/)
  })

  it('top-aligns the side rail on empty hero', () => {
    render(<ChatView {...baseProps} items={[]} />)
    const rail = document.querySelector('[data-chat-side-rail]')
    expect(rail?.className).toMatch(/justify-start/)
    expect(rail?.className).toMatch(/pt-2/)
    expect(rail?.className).not.toMatch(/justify-center/)
  })

  it('top-aligns the side rail when transcript is visible', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )
    const rail = document.querySelector('[data-chat-side-rail]')
    expect(rail?.className).toMatch(/justify-start/)
    expect(rail?.className).toMatch(/pt-2/)
  })

  it('uses symmetric gutter on empty hero (rail overlays edge)', () => {
    render(<ChatView {...baseProps} items={[]} />)
    const hero = document.querySelector('[role="status"]')
    expect(hero?.className).toMatch(/px-4/)
    expect(hero?.className).not.toMatch(/pr-10/)
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()
  })

  it('switches panels via dock tabs while keeping prior panels mounted', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /Add panel/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Changes/i }))
    expect(document.querySelector('[data-changes-panel]')).toBeTruthy()
    expect(document.querySelector('[data-dock-tab-bar]')).toBeTruthy()
    // Multi-tab strip keeps both Terminal and Changes.
    expect(screen.getByRole('tab', { name: /^Terminal$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Changes$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Terminal$/i }))
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(
      document.querySelector('[data-terminal-panel]')?.parentElement?.className
    ).toMatch(/\bflex\b/)
    expect(
      document.querySelector('[data-changes-panel]')?.parentElement?.className
    ).toMatch(/\bhidden\b/)
  })

  it('opens a missing panel from the dock Add panel menu', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /Add panel/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Browser/i }))
    expect(document.querySelector('[data-agent-browser-panel]')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Terminal$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Browser$/i })).toBeTruthy()
  })

  it('enters immersive unified tabs from Expand panel (not a wider side dock)', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    const dock = document.querySelector('[data-right-dock]') as HTMLElement | null
    expect(dock?.getAttribute('data-dock-expanded')).toBe('0')
    const dockWidthPx = Number.parseInt(dock?.style.width ?? '0', 10)
    expect(dockWidthPx).toBe(
      clampDockWidthPx(DOCK_WIDTH_DEFAULT_PX, window.innerWidth, {
        paneCount: 1,
        sidebarWidthPx: readSidebarWidthPxForCapacity(),
        dockOpen: true
      })
    )
    expect(document.querySelector('[data-dock-immersive]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Expand panel$/i }))
    expect(document.querySelector('[data-right-dock]')).toBeNull()
    const immersive = document.querySelector('[data-dock-immersive]')
    expect(immersive).toBeTruthy()
    expect(immersive?.getAttribute('data-dock-expanded')).toBe('1')
    expect(screen.getByRole('tab', { name: /^Agent$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Terminal$/i })).toBeTruthy()
    expect(document.querySelector('[data-dock-tab-variant="immersive"]')).toBeTruthy()
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    // Collapse control must not reuse the window-minimize (minus) icon.
    expect(screen.getByRole('button', { name: /^Collapse panel$/i })).toBeTruthy()
    const tablist = document.querySelector('[data-dock-tab-bar] [role="tablist"]')
    expect(tablist?.className).toMatch(/\bflex-row\b/)
    fireEvent.click(screen.getByRole('button', { name: /^Collapse panel$/i }))
    expect(document.querySelector('[data-dock-immersive]')).toBeNull()
    const restored = document.querySelector('[data-right-dock]') as HTMLElement | null
    expect(restored).toBeTruthy()
    expect(restored?.getAttribute('data-dock-expanded')).toBe('0')
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    // Re-expand and switch to Agent
    fireEvent.click(screen.getByRole('button', { name: /^Expand panel$/i }))
    fireEvent.click(screen.getByRole('tab', { name: /^Agent$/i }))
    expect(document.querySelector('[data-immersive-agent]')?.className).toMatch(/\bflex\b/)
    expect(
      document.querySelector('[data-terminal-panel]')?.parentElement?.className
    ).toMatch(/\bhidden\b/)
  })

  it('portals immersive dock tabs into the titlebar when the shell host is present', () => {
    render(
      <BreakpointProvider>
        <TitleBarAccessoryProvider>
          <TitleBar drawerOpen={false} onToggleSidebar={() => {}} />
          <ChatView {...baseProps} items={[]} />
        </TitleBarAccessoryProvider>
      </BreakpointProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Expand panel$/i }))

    const titlebar = document.querySelector('[data-titlebar]')
    const accessory = document.querySelector('[data-titlebar-accessory]')
    const immersiveBar = document.querySelector('[data-dock-tab-variant="immersive"]')
    expect(titlebar).toBeTruthy()
    expect(accessory).toBeTruthy()
    expect(immersiveBar).toBeTruthy()
    expect(accessory?.contains(immersiveBar)).toBe(true)
    expect(document.querySelector('[data-dock-immersive] [data-dock-tab-bar]')).toBeNull()
    expect(screen.getByRole('tab', { name: /^Agent$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Collapse panel$/i })).toBeTruthy()

    // Accessory host stays draggable; only tab/action clusters are no-drag.
    expect(accessory?.className).not.toMatch(/app-region-no-drag/)
    const tablist = immersiveBar?.querySelector('[role="tablist"]')
    expect(tablist?.className).toMatch(/app-region-no-drag/)
    expect(tablist?.className).not.toMatch(/\bflex-1\b/)
    expect(immersiveBar?.querySelector('[data-titlebar-drag-spacer]')).toBeTruthy()

    // Agent tab matches other tabs: icon then label.
    const agentTab = screen.getByRole('tab', { name: /^Agent$/i })
    const agentChildren = Array.from(agentTab.childNodes).filter(
      (n) => n.nodeType === Node.ELEMENT_NODE
    ) as Element[]
    expect(agentChildren[0]?.tagName.toLowerCase()).toBe('svg')
    expect(agentChildren[1]?.textContent).toMatch(/^Agent$/i)

    expect(screen.getByRole('button', { name: /^Add panel$/i })).toBeTruthy()
    const collapse = screen.getByRole('button', { name: /^Collapse panel$/i })
    expect(collapse.parentElement?.className).toMatch(/\bpr-2\b/)
  })

  it('portals side-dock tabs into the titlebar aligned to the dock column', () => {
    render(
      <BreakpointProvider>
        <TitleBarAccessoryProvider>
          <TitleBar drawerOpen={false} onToggleSidebar={() => {}} />
          <ChatView {...baseProps} items={[]} />
        </TitleBarAccessoryProvider>
      </BreakpointProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: /Show browser panel/i }))

    const accessory = document.querySelector('[data-titlebar-accessory]')
    const portal = document.querySelector('[data-dock-titlebar-portal]')
    const tabsHost = document.querySelector('[data-dock-titlebar-tabs]')
    const dock = document.querySelector('[data-right-dock]')
    expect(accessory?.contains(portal)).toBe(true)
    expect(portal?.querySelector('[data-titlebar-drag-spacer]')).toBeTruthy()
    expect(tabsHost).toBeTruthy()
    expect(document.querySelector('[data-dock-embedded="1"]')).toBeTruthy()
    expect(document.querySelector('[data-dock-column-portal]')).toBeNull()
    expect(dock?.querySelector('[data-dock-tab-bar]')).toBeNull()
    expect(screen.getByRole('tab', { name: /^Browser$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Expand panel$/i })).toBeTruthy()
    expect(screen.getByPlaceholderText('Search or enter URL')).toBeTruthy()

    // Tabs strip is dock width minus caption buttons so left edge matches the panel.
    const dockWidth = Number.parseFloat(
      (dock as HTMLElement | null)?.style.width?.replace('px', '') ?? ''
    )
    const tabsWidth = Number.parseFloat(
      (tabsHost as HTMLElement | null)?.style.width?.replace('px', '') ?? ''
    )
    expect(dockWidth).toBeGreaterThan(0)
    expect(tabsWidth).toBe(dockWidth - 132)
  })

  it('keeps side-dock tabs in the aside when the titlebar host is absent', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show browser panel/i }))

    expect(document.querySelector('[data-dock-titlebar-portal]')).toBeNull()
    expect(document.querySelector('[data-right-dock] [data-dock-tab-bar]')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Browser$/i })).toBeTruthy()
  })

  it('collapsing immersive from Agent restores full chat without a side dock', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Expand panel$/i }))
    fireEvent.click(screen.getByRole('tab', { name: /^Agent$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Collapse panel$/i }))
    expect(document.querySelector('[data-dock-immersive]')).toBeNull()
    expect(document.querySelector('[data-right-dock]')).toBeNull()
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Expand panel$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Expand panel$/i }))
    expect(document.querySelector('[data-dock-immersive]')).toBeTruthy()
    expect(document.querySelector('[data-immersive-agent]')?.className).toMatch(/\bflex\b/)
  })

  it('exposes a drag handle to resize the dock', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    expect(screen.getByRole('separator', { name: /Resize panel/i })).toBeTruthy()
  })

  it('opens the pull request panel from the side rail', () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        prView: vi.fn().mockResolvedValue({ ok: true, data: null })
      }
    })
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show pull request panel/i }))
    expect(document.querySelector('[data-pr-panel]')).toBeTruthy()
  })

  it('renders docked composer in-flow under the transcript', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )

    const composerRoot = document.querySelector('[data-composer-dock]')
    expect(composerRoot?.className).toMatch(/pl-4/)
    expect(composerRoot?.className).toMatch(/pr-10/)
    expect(composerRoot?.className).toMatch(/shrink-0/)
    expect(composerRoot?.className).not.toMatch(/absolute/)
  })

  it('uses dock layout while loading transcript for an active run', () => {
    render(
      <ChatView
        {...baseProps}
        items={[]}
        activeRunId="run-1"
        transcriptLoading
      />
    )

    expect(document.querySelector('[data-composer-hero]')).toBeNull()
    expect(document.querySelector('[data-composer-dock]')).toBeTruthy()
    expect(screen.getAllByText(/loading chat/i).length).toBeGreaterThan(0)
  })

  it('uses dock layout for an active run tab with no messages', () => {
    render(<ChatView {...baseProps} items={[]} activeRunId="run-1" />)

    expect(document.querySelector('[data-composer-hero]')).toBeNull()
    expect(screen.queryByText(/\/create-rule/)).toBeNull()
  })

  it('aligns docked composer with the transcript column', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )

    const transcriptColumn = document.querySelector('[data-chat-column]')
    const composerColumn = document.querySelector('[data-composer-column]')
    for (const el of [transcriptColumn, composerColumn]) {
      expect(el?.className).toMatch(/mx-auto/)
      expect(el?.className).toMatch(/max-w-\[840px\]/)
      expect(el?.className).toMatch(/w-full/)
    }

    const composerRoot = document.querySelector('[data-composer-dock]')
    expect(composerRoot?.className).toMatch(/pl-4/)
    expect(composerRoot?.className).toMatch(/pr-10/)
    expect(composerRoot?.className).toMatch(/shrink-0/)
    expect(composerRoot?.className).not.toMatch(/absolute/)
    expect(composerRoot?.className).not.toMatch(/\bbg-bg\b/)
  })

  it('keeps the transcript free of composer overlay padding', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )

    const stage = document.querySelector('[data-chat-stage]') as HTMLElement | null
    const transcript = document.querySelector('[data-transcript-scroll]') as HTMLElement | null
    expect(stage).toBeTruthy()
    expect(transcript).toBeTruthy()
    expect(stage!.style.getPropertyValue('--vy-dock-h')).toBe('')
    expect(transcript!.style.paddingBottom).toBe('')
    expect(document.querySelector('[data-composer-dock]')).toBeTruthy()
  })

  it('remounts the transcript when chatSurfaceEpoch changes but not for draft alone', () => {
    const items = [
      {
        kind: 'message' as const,
        id: 'm1',
        role: 'user' as const,
        content: 'hello',
        at: '2024-01-01T00:00:00.000Z'
      }
    ]
    const { rerender } = render(
      <ChatView {...baseProps} items={items} chatSurfaceEpoch={0} activeRunId={null} />
    )
    const first = document.querySelector('[data-transcript-scroll]')
    expect(first).toBeTruthy()

    rerender(
      <ChatView {...baseProps} items={items} chatSurfaceEpoch={0} activeRunId="run-1" />
    )
    expect(document.querySelector('[data-transcript-scroll]')).toBe(first)

    rerender(
      <ChatView {...baseProps} items={items} chatSurfaceEpoch={1} activeRunId="run-1" />
    )
    expect(document.querySelector('[data-transcript-scroll]')).not.toBe(first)
  })
})
