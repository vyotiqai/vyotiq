/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AgentBrowserPanel } from '@renderer/features/chat/components/AgentBrowserPanel'

describe('AgentBrowserPanel visibility', () => {
  const browserSetBounds = vi.fn().mockResolvedValue({ ok: true, data: true })

  beforeEach(() => {
    browserSetBounds.mockClear()
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            open: false,
            url: '',
            title: '',
            navigating: false,
            tabs: [],
            canGoBack: false,
            canGoForward: false
          }
        }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('clears native bounds when visible becomes false', () => {
    const { rerender } = render(<AgentBrowserPanel visible={true} />)
    browserSetBounds.mockClear()
    rerender(<AgentBrowserPanel visible={false} />)
    expect(browserSetBounds).toHaveBeenCalledWith(null)
  })

  it('surfaces browserGetState failures', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({ ok: false, error: 'Browser crashed' }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds
      }
    })
    const { findByText } = render(<AgentBrowserPanel visible={true} />)
    expect(await findByText(/Browser state unavailable: Browser crashed/)).toBeTruthy()
  })
})
