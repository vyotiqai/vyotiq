/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorSelection, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  SELECT_SYNC_EVENT,
  ghostText,
  inMidToken,
  tabAutocomplete
} from '@renderer/features/chat/components/tabAutocomplete'

describe('tabAutocomplete', () => {
  let view: EditorView | null = null

  afterEach(() => {
    view?.destroy()
    view = null
    vi.useRealTimers()
  })

  function mount(request: (prefix: string, suffix: string) => Promise<string>): EditorView {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      doc: 'const x = ',
      parent,
      extensions: [tabAutocomplete(() => request)]
    })
    return view
  }

  it('shows ghost text after debounce and keeps it across a same-head selection sync', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => '1')
    const cm = mount(request)
    cm.dispatch({
      changes: { from: 10, insert: 'f' },
      selection: EditorSelection.cursor(11)
    })
    expect(request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalled()
    await Promise.resolve()
    expect(ghostText(cm.state)).toBe('1')

    cm.dispatch({
      selection: EditorSelection.cursor(11),
      annotations: Transaction.userEvent.of(SELECT_SYNC_EVENT)
    })
    expect(ghostText(cm.state)).toBe('1')
  })

  it('does not cancel a pending request when React syncs the caret to the same head', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => 'foo')
    const cm = mount(request)
    cm.dispatch({
      changes: { from: 10, insert: 'a' },
      selection: EditorSelection.cursor(11)
    })
    cm.dispatch({
      selection: EditorSelection.cursor(11),
      annotations: Transaction.userEvent.of(SELECT_SYNC_EVENT)
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(ghostText(cm.state)).toBe('foo')
  })

  it('inserts the ghost on Tab', async () => {
    vi.useFakeTimers()
    const cm = mount(async () => 'bar')
    cm.dispatch({
      changes: { from: 10, insert: 'b' },
      selection: EditorSelection.cursor(11)
    })
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()
    expect(ghostText(cm.state)).toBe('bar')
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true
    })
    cm.contentDOM.dispatchEvent(event)
    expect(cm.state.doc.toString()).toContain('bar')
    expect(ghostText(cm.state)).toBeNull()
  })

  it('shrinks the ghost when the next characters are typed', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => 'ar')
    const cm = mount(request)
    cm.dispatch({
      changes: { from: 10, insert: 'b' },
      selection: EditorSelection.cursor(11)
    })
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()
    expect(ghostText(cm.state)).toBe('ar')
    cm.dispatch({
      changes: { from: 11, insert: 'a' },
      selection: EditorSelection.cursor(12)
    })
    expect(ghostText(cm.state)).toBe('r')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('requests after the caret settles on a token boundary', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => '1')
    const cm = mount(request)
    cm.dispatch({
      selection: EditorSelection.cursor(10)
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(request).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(ghostText(cm.state)).toBe('1')
  })

  it('does not request inside a token', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => 'x')
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      doc: 'foobar',
      parent,
      extensions: [tabAutocomplete(() => request)]
    })
    view.dispatch({
      selection: EditorSelection.cursor(3)
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('inMidToken', () => {
  it('detects identifier interiors only', () => {
    expect(inMidToken('foo', 'bar')).toBe(true)
    expect(inMidToken('foo', ' = 1')).toBe(false)
    expect(inMidToken('foo ', 'bar')).toBe(false)
    expect(inMidToken('', 'foo')).toBe(false)
  })
})
