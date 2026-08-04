/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import { useSettings } from '@renderer/lib/hooks/useSettings'

describe('useSettings sequencing', () => {
  beforeEach(() => {
    // @ts-expect-error test bridge
    window.vyotiq = {
      getSettings: vi.fn(async () => ({ ok: true as const, data: { ...DEFAULT_SETTINGS } })),
      secretStatus: vi.fn(async () => ({
        ok: true as const,
        data: { keys: emptySecretStatus(), encryptionAvailable: true }
      })),
      setSettings: vi.fn(),
      setSecret: vi.fn(),
      clearSecret: vi.fn(),
      pickWorkspace: vi.fn()
    }
  })

  it('ignores a slower setSettings reply after a newer update', async () => {
    let resolveSlow!: (v: unknown) => void
    const slow = new Promise((resolve) => {
      resolveSlow = resolve
    })
    window.vyotiq.setSettings = vi
      .fn()
      .mockImplementationOnce(() => slow)
      .mockImplementationOnce(async (partial: { diagnosticsCommand?: string }) => ({
        ok: true as const,
        data: { ...DEFAULT_SETTINGS, ...partial }
      }))

    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let first!: Promise<unknown>
    let second!: Promise<unknown>
    await act(async () => {
      first = result.current.update({ diagnosticsCommand: 'slow' })
      second = result.current.update({ diagnosticsCommand: 'fast' })
      await second
    })

    resolveSlow({
      ok: true,
      data: { ...DEFAULT_SETTINGS, diagnosticsCommand: 'slow' }
    })
    await act(async () => {
      await first
    })

    expect(result.current.settings.diagnosticsCommand).toBe('fast')
  })
})
