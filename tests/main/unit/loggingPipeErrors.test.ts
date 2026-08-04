import { describe, expect, it } from 'vitest'
import { isIgnorablePipeError } from '@main/logging/pipeErrors'

describe('isIgnorablePipeError', () => {
  it('ignores EPIPE and ECONNRESET', () => {
    expect(isIgnorablePipeError(Object.assign(new Error('write'), { code: 'EPIPE' }))).toBe(true)
    expect(isIgnorablePipeError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(
      true
    )
  })

  it('does not ignore other errors', () => {
    expect(isIgnorablePipeError(new Error('boom'))).toBe(false)
    expect(isIgnorablePipeError(Object.assign(new Error('enoent'), { code: 'ENOENT' }))).toBe(
      false
    )
    expect(isIgnorablePipeError(null)).toBe(false)
    expect(isIgnorablePipeError('EPIPE')).toBe(false)
  })
})
