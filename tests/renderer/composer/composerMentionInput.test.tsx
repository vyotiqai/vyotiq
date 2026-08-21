/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle
} from '@renderer/features/chat/components/composer/ComposerMentionInput'

describe('ComposerMentionInput sync', () => {
  it('clears orphan DOM nodes when controlled value becomes empty', () => {
    const ref = createRef<ComposerMentionInputHandle>()
    const onChange = vi.fn()
    const onKeyDown = vi.fn()
    const { rerender } = render(
      <ComposerMentionInput
        ref={ref}
        value="orphan text"
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    )

    expect(ref.current?.el?.textContent).toBe('orphan text')

    rerender(
      <ComposerMentionInput ref={ref} value="" onChange={onChange} onKeyDown={onKeyDown} />
    )

    expect(ref.current?.el?.textContent ?? '').toBe('')
  })

  it('hides placeholder while composing', () => {
    const ref = createRef<ComposerMentionInputHandle>()
    render(
      <ComposerMentionInput
        ref={ref}
        value=""
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        placeholder="Ask anything…"
      />
    )

    expect(screen.getByText('Ask anything…')).toBeTruthy()
    expect(screen.getByText('Ask anything…').className).toMatch(/\bflex\b/)
    expect(screen.getByText('Ask anything…').className).toMatch(/\bitems-center\b/)

    const el = ref.current?.el
    expect(el).toBeTruthy()
    act(() => {
      el!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })

    expect(screen.queryByText('Ask anything…')).toBeNull()
  })

  it('forwards pasted files and still inserts plain text', () => {
    const onPasteFiles = vi.fn()
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: exec
    })
    const file = new File(['png'], 'shot.png', { type: 'image/png' })
    render(
      <ComposerMentionInput
        value=""
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        onPasteFiles={onPasteFiles}
      />
    )
    const el = screen.getByRole('textbox', { name: /^message$/i })
    fireEvent.paste(el, {
      clipboardData: {
        files: [file],
        items: [],
        getData: (type: string) => (type === 'text/plain' ? 'hello' : '')
      }
    })
    expect(onPasteFiles).toHaveBeenCalledTimes(1)
    expect(onPasteFiles.mock.calls[0]![0][0]).toBe(file)
    expect(exec).toHaveBeenCalledWith('insertText', false, 'hello')
  })
})
