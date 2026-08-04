import { describe, expect, it } from 'vitest'
import type { UiItem } from '@shared/transcript'
import { buildTranscriptRows } from '@renderer/features/chat/utils/transcriptRows'
import { collectTurnFileDiffs } from '@renderer/features/chat/utils/turnFileDiffs'
import { isPlanDraftReady, PLAN_STUB, planHandoffPreview } from '@renderer/features/chat/components/composer/PlanHandoff'

function tool(
  id: string,
  name: string,
  args: Record<string, unknown>,
  status: 'done' | 'running' = 'done'
): Extract<UiItem, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    at: Date.now(),
    tool: {
      toolCallId: id,
      name,
      status,
      summary: typeof args.path === 'string' ? args.path : name,
      argsPreview: JSON.stringify(args)
    }
  }
}

describe('collectTurnFileDiffs', () => {
  it('buckets str_replace diffs by path for the turn', () => {
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'fix', at: 1 },
      tool('t1', 'str_replace', {
        path: 'src/a.ts',
        old_string: 'foo',
        new_string: 'bar'
      })
    ])
    const diffs = collectTurnFileDiffs(rows)
    const turn0 = diffs.get(0)
    expect(turn0?.get('src/a.ts')?.some((l) => l.kind === 'del')).toBe(true)
    expect(turn0?.get('src/a.ts')?.some((l) => l.kind === 'add')).toBe(true)
  })

  it('skips in-flight writing tools', () => {
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'fix', at: 1 },
      tool(
        't1',
        'edit',
        { path: 'src/a.ts', contents: 'x\n' },
        'running'
      )
    ])
    const diffs = collectTurnFileDiffs(rows)
    expect(diffs.get(0)?.size ?? 0).toBe(0)
  })
})

describe('collectLastTurnChangedFiles', () => {
  it('only includes writing tools after the last user message', async () => {
    const { collectLastTurnChangedFiles, collectSessionChangedFiles } = await import(
      '@renderer/features/chat/utils/turnFileDiffs'
    )
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'first', at: 1 },
      tool('t1', 'edit', { path: 'old.ts', contents: 'a\nb\n' }),
      { kind: 'message', id: 'u2', role: 'user', content: 'second', at: 2 },
      tool('t2', 'edit', { path: 'new.ts', contents: 'x\ny\n' })
    ]
    const last = collectLastTurnChangedFiles(items)
    const session = collectSessionChangedFiles(items)
    expect(session.some((f) => f.path === 'old.ts')).toBe(true)
    expect(last.some((f) => f.path === 'old.ts')).toBe(false)
    expect(last.some((f) => f.path === 'new.ts')).toBe(true)
  })
})

describe('isPlanDraftReady', () => {
  it('rejects empty and stub plan.md', () => {
    expect(isPlanDraftReady(null)).toBe(false)
    expect(isPlanDraftReady(PLAN_STUB)).toBe(false)
  })

  it('rejects outline-only templates without body text', () => {
    expect(
      isPlanDraftReady(
        '# Plan\n\n_Draft the plan here. Update as you learn._\n\n## Goal\n\n## Approach\n'
      )
    ).toBe(false)
  })

  it('rejects verbose headings, punctuated headings, HR, and tiny stubs', () => {
    expect(
      isPlanDraftReady('# Plan\n\n## One two three four five words here\n\n## Goal.\n\n---\n\n```\n')
    ).toBe(false)
    expect(isPlanDraftReady('# Plan\n\nTODO\n')).toBe(false)
    expect(isPlanDraftReady('# Plan\n\n- [ ] x\n')).toBe(false)
  })

  it('accepts a drafted plan', () => {
    expect(isPlanDraftReady('# Plan\n\n1. Do the thing\n')).toBe(true)
  })
})

describe('planHandoffPreview', () => {
  it('skips stub hints and bare headings', () => {
    const preview = planHandoffPreview(
      '# Plan\n\n_Draft the plan here. Update as you learn._\n\n## Goal\n\nShip the feature\n\n## Approach\n\nUse tests\n'
    )
    expect(preview).toBe('Ship the feature · Use tests')
    expect(preview).not.toMatch(/Draft the plan|##/)
  })
})
