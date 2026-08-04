import { describe, expect, it } from 'vitest'
import { MAX_REPAIR_BYTES, repairToolArgs } from '@main/agent/toolArgsRepair'

describe('repairToolArgs', () => {
  it('returns valid JSON unchanged', () => {
    expect(repairToolArgs('{"path":"a.ts"}')).toBe('{"path":"a.ts"}')
  })

  it('closes an unclosed brace', () => {
    const repaired = repairToolArgs('{"path":"a.ts"')
    expect(repaired && JSON.parse(repaired)).toEqual({ path: 'a.ts' })
  })

  it('drops a trailing comma', () => {
    const repaired = repairToolArgs('{"path":"a.ts",')
    expect(repaired && JSON.parse(repaired)).toEqual({ path: 'a.ts' })
  })

  it('closes nested containers in order', () => {
    const repaired = repairToolArgs('{"edits":[{"path":"a.ts"')
    expect(repaired && JSON.parse(repaired)).toEqual({ edits: [{ path: 'a.ts' }] })
  })

  it('discards a half-received key instead of guessing a value', () => {
    const repaired = repairToolArgs('{"path":"a.ts","content"')
    expect(repaired && JSON.parse(repaired)).toEqual({ path: 'a.ts' })
  })

  it('discards a key whose value never arrived', () => {
    const repaired = repairToolArgs('{"path":"a.ts","content":')
    expect(repaired && JSON.parse(repaired)).toEqual({ path: 'a.ts' })
  })

  it('drops an unterminated first key entirely', () => {
    const repaired = repairToolArgs('{"pa')
    expect(repaired && JSON.parse(repaired)).toEqual({})
  })

  it('keeps escaped quotes inside a truncated string intact', () => {
    const repaired = repairToolArgs('{"content":"say \\"hi')
    expect(repaired && JSON.parse(repaired)).toEqual({ content: 'say "hi' })
  })

  it('refuses input that is not an object', () => {
    expect(repairToolArgs('"just a string')).toBeNull()
    expect(repairToolArgs('')).toBeNull()
  })

  it('repairs large truncated edit payloads (live Luna ~293 KiB case)', () => {
    // Under the old 256 KiB cap this returned null and became TOOL_ARGS.
    const body = 'x'.repeat(280_000)
    const raw = `{"path":"contract.md","contents":"${body}`
    expect(raw.length).toBeGreaterThan(256 * 1024)
    expect(raw.length).toBeLessThanOrEqual(MAX_REPAIR_BYTES)
    const repaired = repairToolArgs(raw)
    expect(repaired && JSON.parse(repaired)).toEqual({
      path: 'contract.md',
      contents: body
    })
  })

  it('refuses absurdly large payloads rather than scanning them', () => {
    expect(repairToolArgs(`{"a":"${'x'.repeat(MAX_REPAIR_BYTES)}`)).toBeNull()
  })
})
