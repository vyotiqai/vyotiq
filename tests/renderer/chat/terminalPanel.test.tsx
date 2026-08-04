/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { TerminalPanel } from '@renderer/features/chat/components/TerminalPanel'
import type { PtySessionInfo } from '@shared/ipc'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(): void {}
    writeln(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined }
    }
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  }
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {}
}))

const session: PtySessionInfo = {
  id: 'sess-1',
  title: 'cmd',
  cwd: '/ws',
  running: true,
  backend: 'pty'
}

beforeEach(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0) as unknown as number
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TerminalPanel', () => {
  it('shows a pty host after successful list + auto-create', async () => {
    const ptyList = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: [] as PtySessionInfo[] })
      .mockResolvedValue({ ok: true, data: [session] })
    const ptyCreate = vi.fn().mockResolvedValue({ ok: true, data: session })

    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ptyList,
        ptyCreate,
        ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
        onPtyData: vi.fn().mockReturnValue(() => undefined),
        onPtyExit: vi.fn().mockReturnValue(() => undefined)
      }
    })

    render(<TerminalPanel workspacePath="/ws" visible />)

    await waitFor(() => {
      expect(document.querySelector('[data-pty-host]')).toBeTruthy()
    })
    expect(screen.queryByText('No terminal')).toBeNull()
    expect(ptyCreate).toHaveBeenCalled()
  })

  it('surfaces ptyCreate failure as an error banner', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ptyList: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        ptyCreate: vi.fn().mockResolvedValue({ ok: false, error: 'spawn failed' }),
        ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
        onPtyData: vi.fn().mockReturnValue(() => undefined),
        onPtyExit: vi.fn().mockReturnValue(() => undefined)
      }
    })

    render(<TerminalPanel workspacePath="/ws" visible />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('spawn failed')
    expect(document.querySelector('[data-terminal-error]')).toBeTruthy()
    expect(screen.getByText('No terminal')).toBeTruthy()
  })

  it('shows empty-state copy when no workspace is open', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ptyList: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        ptyCreate: vi.fn(),
        onPtyData: vi.fn().mockReturnValue(() => undefined),
        onPtyExit: vi.fn().mockReturnValue(() => undefined)
      }
    })

    render(<TerminalPanel workspacePath={null} visible />)

    expect(await screen.findByText('No terminal')).toBeTruthy()
    expect(screen.getByText(/Open a workspace to start an interactive shell/i)).toBeTruthy()
    expect(window.vyotiq.ptyCreate).not.toHaveBeenCalled()
  })
})
