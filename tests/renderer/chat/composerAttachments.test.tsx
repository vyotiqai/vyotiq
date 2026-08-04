/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useComposerImages } from '@renderer/features/chat/components/composer/useComposerImages'
import { useComposerFiles } from '@renderer/features/chat/components/composer/useComposerFiles'
import {
  getComposerAttachments,
  resetComposerAttachmentStoreForTests
} from '@renderer/lib/hooks/composerAttachmentStore'

afterEach(() => {
  cleanup()
  resetComposerAttachmentStoreForTests()
})

describe('composer attachment persistence', () => {
  it('keeps images in the workspace store across hook remounts', () => {
    const first = renderHook(() => useComposerImages('/ws/a'))
    act(() => {
      first.result.current.setImages(['data:image/png;base64,x'])
    })
    expect(first.result.current.images).toHaveLength(1)
    first.unmount()

    // Remount (run-tab switch bumps surfaceKey) — state comes back from the store.
    const second = renderHook(() => useComposerImages('/ws/a'))
    expect(second.result.current.images).toEqual(['data:image/png;base64,x'])
  })

  it('scopes attachments per workspace path', () => {
    const a = renderHook(() => useComposerImages('/ws/a'))
    act(() => {
      a.result.current.setImages(['img-a'])
    })
    const b = renderHook(() => useComposerImages('/ws/b'))
    expect(b.result.current.images).toEqual([])
  })

  it('keeps files and native files across remounts via persistKey', () => {
    const first = renderHook(() => useComposerFiles({ persistKey: '/ws/a' }))
    act(() => {
      first.result.current.setFiles([{ type: 'file', name: 'a.md', mime: 'text/markdown', text: 'hi' }])
      first.result.current.setNativeFiles([
        { type: 'file_native', name: 'b.pdf', mime: 'application/pdf', data: 'zz' }
      ])
    })
    first.unmount()

    const second = renderHook(() => useComposerFiles({ persistKey: '/ws/a' }))
    expect(second.result.current.files).toHaveLength(1)
    expect(second.result.current.nativeFiles).toHaveLength(1)
    expect(getComposerAttachments('/ws/a').files[0]?.name).toBe('a.md')
  })

  it('falls back to local state without a persistKey', () => {
    const hook = renderHook(() => useComposerImages())
    act(() => {
      hook.result.current.setImages(['local'])
    })
    expect(hook.result.current.images).toEqual(['local'])
    expect(getComposerAttachments('/ws/a').images).toEqual([])
  })
})
