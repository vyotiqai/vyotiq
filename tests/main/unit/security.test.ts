import { describe, expect, it, vi } from 'vitest'

const openExternalMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  shell: {
    openExternal: openExternalMock
  }
}))

import { attachSecurity, buildCspPolicy, needsViteHmrCsp } from '@main/app/security'

describe('buildCspPolicy', () => {
  it('uses strict production policy without Vite HMR URL', () => {
    const policy = buildCspPolicy({ electronRendererUrl: undefined })
    expect(policy).toContain("script-src 'self'")
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).not.toContain('blob:')
    expect(policy).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('allows HMR websocket + inline scripts when electron-vite dev URL is set', () => {
    const policy = buildCspPolicy({ electronRendererUrl: 'http://127.0.0.1:5173/' })
    expect(policy).toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).toContain('ws://127.0.0.1:*')
    expect(policy).toContain('blob:')
    expect(policy).not.toContain('unsafe-eval')
  })

  it('needsViteHmrCsp mirrors electronRendererUrl presence', () => {
    expect(needsViteHmrCsp({})).toBe(false)
    expect(needsViteHmrCsp({ electronRendererUrl: 'http://127.0.0.1:5173/' })).toBe(true)
  })
})

describe('attachSecurity', () => {
  it('opens https links externally and denies in-app window creation', () => {
    openExternalMock.mockReset()
    const handlers: {
      windowOpen?: (detail: { url: string }) => { action: string }
      willNavigate?: (event: { preventDefault: () => void }, url: string) => void
      permission?: (callback: (allowed: boolean) => void) => void
    } = {}

    const webContents = {
      getURL: () => 'file:///renderer/index.html',
      setWindowOpenHandler: (fn: typeof handlers.windowOpen) => {
        handlers.windowOpen = fn
      },
      on: (event: string, fn: unknown) => {
        if (event === 'will-navigate') handlers.willNavigate = fn as typeof handlers.willNavigate
      },
      session: {
        setPermissionRequestHandler: (
          _fn: (wc: unknown, permission: string, callback: (allowed: boolean) => void) => void
        ) => {
          handlers.permission = (callback) => _fn({}, 'notifications', callback)
        }
      }
    }

    attachSecurity({ webContents } as never)

    const denied = handlers.windowOpen!({ url: 'https://example.com/docs' })
    expect(denied).toEqual({ action: 'deny' })
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/docs')

    handlers.windowOpen!({ url: 'http://insecure.example/' })
    expect(openExternalMock).toHaveBeenCalledTimes(1)

    const event = { preventDefault: vi.fn() }
    handlers.willNavigate!(event, 'https://evil.example/')
    expect(event.preventDefault).toHaveBeenCalled()

    const permissionCb = vi.fn()
    handlers.permission!(permissionCb)
    expect(permissionCb).toHaveBeenCalledWith(false)
  })
})
