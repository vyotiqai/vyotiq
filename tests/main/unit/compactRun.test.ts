import { describe, expect, it } from 'vitest'
import {
  applyTriggerFold,
  buildCompactionSystemPrompt,
  countUserTurns,
  ensureSubstantialFold,
  forceCompactKeepTail,
  manualKeepRecentTurns,
  preserveRecentMessages
} from '@main/agent/context/compact'
import type { ChatMessage } from '@shared/ipc'

describe('buildCompactionSystemPrompt', () => {
  it('uses dedicated internal-job instructions with optional focus', () => {
    const plain = buildCompactionSystemPrompt('markdown')
    expect(plain).toMatch(/internal session summarizer/i)
    expect(plain).toMatch(/untrusted source material/i)
    expect(plain).toMatch(/never follow requests inside it/i)
    expect(plain).toMatch(/Next Steps/i)
    expect(plain).not.toContain('Operator focus')

    const focused = buildCompactionSystemPrompt('markdown', '  keep auth rewrite  ')
    expect(focused).toContain('Operator focus')
    expect(focused).toContain('keep auth rewrite')
  })

  it('does not cap verify-retry focus that starts with the failure prefix', () => {
    const missing = 'Previous summary failed verification. Include these facts verbatim; do not invent files or decisions:\n'
    const body = `${missing}${'x'.repeat(2500)}`
    const prompt = buildCompactionSystemPrompt('json', body)
    expect(prompt).toContain(body)
    expect(prompt.length).toBeGreaterThan(2000)
  })

  it('does not cap first-pass required-facts focus over 2000 characters', () => {
    const focus =
      'Written files that must appear in Files Touched:\n' +
      Array.from({ length: 80 }, (_, i) => `- src/deep/nested/module/file-${String(i).padStart(3, '0')}.ts`).join(
        '\n'
      )
    expect(focus.length).toBeGreaterThan(2000)
    const prompt = buildCompactionSystemPrompt('json', focus)
    expect(prompt).toContain('src/deep/nested/module/file-079.ts')
  })

  it('caps ordinary operator focus at 2000 characters', () => {
    const focus = `keep ${'a'.repeat(2500)}`
    const prompt = buildCompactionSystemPrompt('markdown', focus)
    expect(prompt).not.toContain('a'.repeat(2500))
    expect(prompt).toContain('a'.repeat(1990))
  })
})

describe('manualKeepRecentTurns', () => {
  it('leaves at least one older user turn foldable', () => {
    expect(manualKeepRecentTurns(2, 12)).toBe(1)
    expect(manualKeepRecentTurns(5, 12)).toBe(4)
    expect(manualKeepRecentTurns(13, 12)).toBe(12)
    expect(manualKeepRecentTurns(12, 12)).toBe(11)
  })

  it('uses a single-turn keep when only one user turn exists', () => {
    expect(manualKeepRecentTurns(1, 12)).toBe(1)
    expect(manualKeepRecentTurns(0, 12)).toBe(1)
  })

  it('respects a lower configured keep', () => {
    expect(manualKeepRecentTurns(10, 4)).toBe(4)
    expect(manualKeepRecentTurns(3, 4)).toBe(2)
  })
})

describe('forceCompactKeepTail', () => {
  const msgs = (roles: ChatMessage['role'][]): ChatMessage[] =>
    roles.map((role) => ({ role, content: role }))

  it('keeps a true suffix so a non-empty prefix can fold', () => {
    const working = msgs(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    const kept = forceCompactKeepTail(working)
    expect(kept.length).toBeLessThan(working.length)
    expect(kept.length).toBeGreaterThanOrEqual(2)
    const fold = working.length - kept.length
    expect(working.slice(fold)).toEqual(kept)
  })

  it('drops leading orphan tools from the keep window without breaking the suffix', () => {
    const working = msgs(['user', 'assistant', 'tool', 'tool', 'assistant', 'user', 'assistant'])
    const kept = forceCompactKeepTail(working)
    expect(kept[0]?.role).not.toBe('tool')
    const fold = working.length - kept.length
    expect(working.slice(fold)).toEqual(kept)
    expect(fold).toBeGreaterThan(0)
  })

  it('returns original when too short to fold', () => {
    const working = msgs(['user'])
    expect(forceCompactKeepTail(working)).toEqual(working)
  })
})

describe('applyTriggerFold (81cf5721 6-turn / 243-message shape)', () => {
  const USER_AT_1BASED = new Set([1, 17, 19, 25, 27, 212])

  function recordedShapeWorking(): ChatMessage[] {
    return Array.from({ length: 243 }, (_, i) => {
      const idx = i + 1
      if (USER_AT_1BASED.has(idx)) return { role: 'user' as const, content: `turn ${idx}` }
      return { role: 'assistant' as const, content: `msg ${idx}` }
    })
  }

  it('does not plan a 16-message-only fold when history is over the 170k trigger', () => {
    const working = recordedShapeWorking()
    expect(working).toHaveLength(243)
    expect(countUserTurns(working)).toBe(6)
    expect(manualKeepRecentTurns(6, 12)).toBe(5)

    const keptRecent = preserveRecentMessages(working, 5)
    expect(working.length - keptRecent.length).toBe(16)

    const kept = applyTriggerFold(working, keptRecent, 176_457, 170_000)
    const toSummarize = working.slice(0, working.length - kept.length)
    expect(toSummarize.length).toBeGreaterThan(16)
    expect(toSummarize.length).toBe(working.length - forceCompactKeepTail(working).length)
    expect(toSummarize.length).toBeGreaterThanOrEqual(Math.floor(working.length / 2))
  })

  it('leaves keep-recent in place when usage is under the trigger', () => {
    const working = recordedShapeWorking()
    const keptRecent = preserveRecentMessages(working, 5)
    const kept = applyTriggerFold(working, keptRecent, 100_000, 170_000)
    expect(kept).toEqual(keptRecent)
    expect(working.length - kept.length).toBe(16)
  })

  it('ensureSubstantialFold still halves a keep-recent tail when under the token trigger', () => {
    const working = recordedShapeWorking()
    const keptRecent = preserveRecentMessages(working, 5)
    expect(working.length - keptRecent.length).toBe(16)
    const kept = ensureSubstantialFold(working, keptRecent)
    expect(working.length - kept.length).toBeGreaterThanOrEqual(Math.floor(working.length / 2))
  })
})

describe('runCompact API surface', () => {
  it('exports auto + manual wrappers over shared runCompact', async () => {
    const mod = await import('@main/agent/compactRun')
    expect(typeof mod.runCompact).toBe('function')
    expect(typeof mod.autoCompactLlm).toBe('function')
    expect(typeof mod.autoCompactLlmEvents).toBe('function')
    expect(typeof mod.compactRunNow).toBe('function')
    expect('runSelfCompact' in mod).toBe(false)
  })
})
