import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissToast,
  getToasts,
  pushToast,
  resetToastStoreForTests
} from '@renderer/lib/ui/toastStore'

beforeEach(() => {
  resetToastStoreForTests()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  resetToastStoreForTests()
})

describe('toastStore', () => {
  it('stacks toasts and auto-dismisses after the duration', () => {
    pushToast('one')
    pushToast('two', 'success')
    expect(getToasts().map((t) => t.message)).toEqual(['one', 'two'])
    vi.advanceTimersByTime(6000)
    expect(getToasts()).toEqual([])
  })

  it('replaces an identical visible toast instead of stacking duplicates', () => {
    pushToast('same')
    pushToast('same')
    expect(getToasts()).toHaveLength(1)
  })

  it('caps the stack at the max, keeping the newest', () => {
    for (let i = 1; i <= 6; i++) pushToast(`t${i}`)
    expect(getToasts().map((t) => t.message)).toEqual(['t3', 't4', 't5', 't6'])
  })

  it('dismisses a toast by id and ignores unknown ids', () => {
    const id = pushToast('bye')
    dismissToast(id)
    dismissToast(9999)
    expect(getToasts()).toEqual([])
  })

  it('ignores blank messages', () => {
    expect(pushToast('   ')).toBe(-1)
    expect(getToasts()).toEqual([])
  })
})
