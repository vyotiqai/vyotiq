import { describe, expect, it } from 'vitest'
import { compileUserRegex, USER_REGEX_MAX_LENGTH } from '@main/agent/tools/safeUserRegex'

describe('compileUserRegex', () => {
  it('compiles ordinary patterns', () => {
    expect(compileUserRegex('ready').test('ready now')).toBe(true)
    expect(compileUserRegex('foo', 'i').test('FOO')).toBe(true)
  })

  it('rejects empty and oversized patterns', () => {
    expect(() => compileUserRegex('   ')).toThrow(/Empty/)
    expect(() => compileUserRegex('a'.repeat(USER_REGEX_MAX_LENGTH + 1))).toThrow(/exceeds/)
  })

  it('rejects nested quantifiers', () => {
    expect(() => compileUserRegex('(a+)+')).toThrow(/nested quantifiers/)
    expect(() => compileUserRegex('(a*)*')).toThrow(/nested quantifiers/)
  })
})
