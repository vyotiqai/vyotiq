/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSlashCommands } from '@renderer/features/chat/components/composer/useSlashCommands'
import { mentionMarker } from '@renderer/features/chat/components/composer/mentionModel'

const commands = [
  {
    id: 'builtin:a',
    trigger: 'alpha',
    label: 'Alpha',
    description: 'A',
    kind: 'builtin' as const,
    group: 'App',
    availability: 'ready' as const
  },
  {
    id: 'builtin:b',
    trigger: 'beta',
    label: 'Beta',
    description: 'B',
    kind: 'builtin' as const,
    group: 'App',
    availability: 'ready' as const
  }
]

beforeEach(() => {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      slashCommandsList: vi.fn().mockResolvedValue({ ok: true, data: { commands } })
    }
  })
})

describe('useSlashCommands navigation', () => {
  it('clamps arrow navigation at the ends', async () => {
    const { result } = renderHook(() =>
      useSlashCommands({
        text: '/',
        cursor: 1,
        enabled: true
      })
    )

    await act(async () => {
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(result.current.filtered.length).toBe(2))

    act(() => result.current.moveActive(-1))
    expect(result.current.activeIndex).toBe(0)

    act(() => result.current.moveActive(1))
    expect(result.current.activeIndex).toBe(1)

    act(() => result.current.moveActive(1))
    expect(result.current.activeIndex).toBe(1)
  })

  it('prefetches the catalog when a slash chip is already in the draft', async () => {
    const chip = `${mentionMarker({
      kind: 'slash',
      slashKind: 'skill',
      trigger: 'code-review',
      commandId: 'skill:code-review'
    })} trailing`
    const { result } = renderHook(() =>
      useSlashCommands({
        text: chip,
        cursor: chip.length,
        enabled: true
      })
    )

    await vi.waitFor(() => expect(result.current.commands.length).toBe(2))
    expect(window.vyotiq.slashCommandsList).toHaveBeenCalled()
  })

  it('ensureCommands returns the list without a second fetch when already loaded', async () => {
    const { result } = renderHook(() =>
      useSlashCommands({
        text: '/',
        cursor: 1,
        enabled: true
      })
    )

    await vi.waitFor(() => expect(result.current.commands.length).toBe(2))
    const list = vi.mocked(window.vyotiq.slashCommandsList)
    const calls = list.mock.calls.length

    let ensured: typeof commands = []
    await act(async () => {
      ensured = await result.current.ensureCommands()
    })
    expect(ensured).toEqual(commands)
    expect(list.mock.calls.length).toBe(calls)
  })
})
