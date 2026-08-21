/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_LOCAL_STORAGE_KEY } from '@shared/appearance'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { useAppearance } from '@renderer/lib/hooks/useAppearance'

describe('useAppearance', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-font-scale')
    document.documentElement.removeAttribute('data-density')
    document.documentElement.removeAttribute('data-accent')
    // @ts-expect-error test bridge
    window.vyotiq = {
      getSystemTheme: vi.fn(async () => ({ ok: true as const, data: false })),
      onSystemThemeChanged: vi.fn(() => () => undefined)
    }
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('applies appearance attributes to the document root', () => {
    renderHook(() =>
      useAppearance({
        theme: 'dark',
        fontScale: 'large',
        uiDensity: 'compact',
        accentPreset: 'blue'
      })
    )
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.getAttribute('data-font-scale')).toBe('large')
    expect(root.getAttribute('data-density')).toBe('compact')
    expect(root.getAttribute('data-accent')).toBe('blue')
  })

  it('writes boot cache on apply', async () => {
    const { result } = renderHook(() => useAppearance(DEFAULT_SETTINGS))
    act(() => {
      result.current.setAppearance({ theme: 'light', accentPreset: 'green' })
    })
    await waitFor(() => {
      const raw = localStorage.getItem(APPEARANCE_LOCAL_STORAGE_KEY)
      expect(raw).toBeTruthy()
      expect(raw).toContain('"theme":"light"')
      expect(raw).toContain('"accentPreset":"green"')
    })
  })

  it('reacts to native system theme IPC when theme is system', async () => {
    let handler: ((prefersDark: boolean) => void) | undefined
    // @ts-expect-error test bridge
    window.vyotiq = {
      getSystemTheme: vi.fn(async () => ({ ok: true as const, data: true })),
      onSystemThemeChanged: vi.fn((cb: (prefersDark: boolean) => void) => {
        handler = cb
        return () => undefined
      })
    }
    renderHook(() =>
      useAppearance({
        theme: 'system',
        fontScale: 'default',
        uiDensity: 'default',
        accentPreset: 'neutral'
      })
    )
    await waitFor(() => expect(handler).toBeTypeOf('function'))
    act(() => handler?.(true))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
