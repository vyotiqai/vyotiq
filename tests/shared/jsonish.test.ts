import { describe, expect, it } from 'vitest'
import { closeUnterminatedJson, completeJsonPrefix, parseJsonish } from '@shared/utils/jsonish'

describe('completeJsonPrefix', () => {
  it('returns the first complete value when trailing junk follows', () => {
    expect(completeJsonPrefix('{"path":"a.ts"}}')).toBe('{"path":"a.ts"}')
    expect(completeJsonPrefix('[{"id":"q1"}]}')).toBe('[{"id":"q1"}]')
  })

  it('returns null when the value is already complete or still open', () => {
    expect(completeJsonPrefix('{"path":"a.ts"}')).toBeNull()
    expect(completeJsonPrefix('[{"id":"q1"}')).toBeNull()
  })
})

describe('closeUnterminatedJson', () => {
  it('closes a missing array bracket after a complete object', () => {
    const open = '[{"id":"q1","prompt":"Ready?","type":"text"}'
    expect(closeUnterminatedJson(open)).toBe(`${open}]`)
  })

  it('refuses salvage when EOF is inside a string', () => {
    expect(closeUnterminatedJson('[{"id":"q1","prompt":"Hel')).toBeNull()
  })

  it('refuses salvage after a colon or comma', () => {
    expect(closeUnterminatedJson('{"a":')).toBeNull()
    expect(closeUnterminatedJson('[{"id":"q1"},')).toBeNull()
  })
})

describe('parseJsonish', () => {
  it('parses valid JSON', () => {
    expect(parseJsonish('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonish('[1,2]')).toEqual([1, 2])
  })

  it('drops trailing junk after a complete value', () => {
    expect(parseJsonish('[{"id":"q1"}]}')).toEqual([{ id: 'q1' }])
  })

  it('closes an unclosed questions array (live 0898dc11 shape)', () => {
    const items = [
      { id: 'purpose', prompt: 'What task?', type: 'text' },
      { id: 'placement', prompt: 'Where?', type: 'single', options: ['A', 'B'] }
    ]
    const unclosed = JSON.stringify(items).slice(0, -1)
    expect(parseJsonish(unclosed)).toEqual(items)
  })

  it('unwraps double-encoded JSON once', () => {
    const items = [{ id: 'q1', prompt: 'Ready?', type: 'text' }]
    expect(parseJsonish(JSON.stringify(JSON.stringify(items)))).toEqual(items)
  })

  it('returns undefined for unescaped-quote garbage', () => {
    const malformed =
      '[{"id": "how_open", "prompt": "How?", "type": "single", "options": ["A VS Code "Live Server" or similar", "Other"]}]'
    expect(parseJsonish(malformed)).toBeUndefined()
  })
})
