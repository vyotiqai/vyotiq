import { describe, expect, it } from 'vitest'

import { mapToolGroupProps } from '@renderer/features/chat/utils/toolGroupAdapter'

import type { UiToolRow } from '@shared/transcript'



function tool(

  id: string,

  name: string,

  summary: string,

  status: UiToolRow['status'] = 'done',

  content?: string

): UiToolRow {

  return { id, name, summary, status, content }

}



describe('mapToolGroupProps', () => {

  it('maps pending state when group is open and tools are running', () => {

    const result = mapToolGroupProps(

      [tool('t1', 'read', 'src/a.ts', 'running'), tool('t2', 'search', 'query', 'running')],

      { groupTiming: { startedAt: 1_000 } }

    )

    expect(result.state).toBe('pending')

    expect(result.nestedTools).toHaveLength(2)

    expect(result.nestedTools[0]?.category).toBe('file')

    expect(result.nestedTools[1]?.category).toBe('search')

    expect(result.summary).toBe('1 file and 1 lookup')

  })



  it('maps completed state when group timing is closed', () => {

    const result = mapToolGroupProps(

      [

        tool('t1', 'read', 'src/a.ts'),

        tool('t2', 'terminal', 'pnpm test'),

        tool('t3', 'search', 'foo')

      ],

      { groupTiming: { startedAt: 1_000, endedAt: 7_000 } }

    )

    expect(result.state).toBe('completed')

    expect(result.summary).toBe('1 file, 1 lookup, and 1 command')

    expect(result.elapsedDisplay).toBe('6s')

  })



  it('completes a finished group whose timing is still open', () => {

    const result = mapToolGroupProps([tool('t1', 'read', 'src/a.ts'), tool('t2', 'search', 'q')], {

      groupTiming: { startedAt: 1_000 }

    })

    expect(result.state).toBe('completed')

  })



  it('maps interrupted state from cancelled tool content', () => {
    const result = mapToolGroupProps(
      [tool('t1', 'read', 'src/a.ts', 'fail', 'Cancelled')],
      { groupTiming: { startedAt: 1_000, endedAt: 2_000 } }
    )
    expect(result.state).toBe('interrupted')
    expect(result.doneLabel).toBe('Reading')
    expect(result.nestedTools[0]?.title).toBe('Reading')
    expect(result.nestedTools[0]?.subtitle).toMatch(/a\.ts/)
  })

  it('uses Asking not Asked for interrupted ask_question', () => {
    const result = mapToolGroupProps(
      [tool('t1', 'ask_question', 'Should I continue?', 'fail', 'Cancelled')],
      { groupTiming: { startedAt: 1_000, endedAt: 2_000 } }
    )
    expect(result.state).toBe('interrupted')
    expect(result.doneLabel).toBe('Asking')
    expect(result.nestedTools[0]?.title).toBe('Asking')
  })



  it('maps MCP list tools to browse category with path-only nested title', () => {

    const result = mapToolGroupProps(

      [

        tool('t1', 'mcp__github__list_issues', 'vyotiq', 'done'),

        tool('t2', 'mcp__github__list_labels', 'repo', 'done')

      ],

      { groupTiming: { startedAt: 1_000, endedAt: 2_000 } }

    )

    expect(result.nestedTools[0]?.category).toBe('browse')

    expect(result.nestedTools[0]?.title).toBe('vyotiq')

    expect(result.nestedTools[0]?.subtitle).toBe('')

  })



  it('uses basename for file tool subtitles', () => {

    const result = mapToolGroupProps([tool('t1', 'read', 'src/components/Chat.tsx')], {

      groupTiming: { startedAt: 1_000, endedAt: 2_000 }

    })

    expect(result.nestedTools[0]?.subtitle).toBe('Chat.tsx')

  })



  it('shows the line range a ranged read asked for', () => {

    const row = tool('t1', 'read', 'src/app.css')

    row.argsPreview = JSON.stringify({ path: 'src/app.css', startLine: 12, endLine: 48 })

    const result = mapToolGroupProps([row], { groupTiming: { startedAt: 1 } })

    expect(result.nestedTools[0]?.subtitle).toBe('app.css L12-48')

  })



  it('marks an open-ended read range rather than inventing its end', () => {

    const row = tool('t1', 'read', 'src/app.css')

    row.argsPreview = JSON.stringify({ startLine: 12 })

    const result = mapToolGroupProps([row], { groupTiming: { startedAt: 1 } })

    expect(result.nestedTools[0]?.subtitle).toBe('app.css L12+')

  })



  it('derives the range from the text when a whole file came back', () => {

    const row = tool('t1', 'read', 'a.css', 'done', 'one\ntwo\nthree\n')

    const result = mapToolGroupProps([row], { groupTiming: { startedAt: 1 } })

    expect(result.nestedTools[0]?.subtitle).toBe('a.css L1-3')

  })



  it('stays silent about the range when only a preview arrived', () => {

    const row = tool('t1', 'read', 'a.css', 'done', 'one\ntwo')

    row.contentTruncated = true

    const result = mapToolGroupProps([row], { groupTiming: { startedAt: 1 } })

    expect(result.nestedTools[0]?.subtitle).toBe('a.css')

  })

  it('uses composite verbs for mixed-category groups', () => {
    const result = mapToolGroupProps(
      [
        tool('t1', 'read', 'src/a.ts'),
        tool('t2', 'list_dir', '.'),
        tool('t3', 'list_dir', 'src')
      ],
      { groupTiming: { startedAt: 1_000, endedAt: 2_000 } }
    )

    expect(result.doneLabel).toBe('Read and listed')
    expect(result.summary).toBe('1 file and 2 directories')
  })

  it('uses Exploring for three-or-more category mixes', () => {
    const result = mapToolGroupProps(
      [
        tool('t1', 'list_dir', '.'),
        tool('t2', 'terminal', 'pnpm test'),
        tool('t3', 'edit', 'src/a.ts')
      ],
      { groupTiming: { startedAt: 1_000 } }
    )

    expect(result.runningLabel).toBe('Exploring')
    expect(result.doneLabel).toBe('Explored')
    expect(result.summary).toBe('1 edit, 1 command, and 1 directory')
  })

  it('shows a preparing label for unresolved streaming tool rows in a group', () => {
    const result = mapToolGroupProps(
      [tool('t1', 'tool', '', 'running')],
      { groupTiming: { startedAt: 1_000 } }
    )

    expect(result.nestedTools[0]?.title).toBe('Preparing…')
  })

  it('keeps Preparing even when unresolved rows already have streaming args', () => {
    const row = tool('t1', 'tool', 'Tool', 'running')
    row.argsPreview = JSON.stringify({
      todos: [{ id: 'audit-1', content: 'Audit Auth', status: 'in_progress' }]
    })
    const result = mapToolGroupProps([row], { groupTiming: { startedAt: 1_000 } })

    expect(result.nestedTools[0]?.title).toBe('Preparing…')
    expect(result.nestedTools[0]?.subtitle).toBe('')
  })



})

