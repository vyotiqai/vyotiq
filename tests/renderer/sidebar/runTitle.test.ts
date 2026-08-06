import { describe, expect, it } from 'vitest'
import { namedGitBranch } from '@shared/utils/gitBranch'
import { runTitle, runTooltip, runSearchText, stripGoalMarkdown } from '@renderer/app/sidebar/runTitle'
import type { RunSummary } from '@shared/ipc'

describe('namedGitBranch', () => {
  it('maps empty and HEAD to null', () => {
    expect(namedGitBranch(null)).toBeNull()
    expect(namedGitBranch('')).toBeNull()
    expect(namedGitBranch('  ')).toBeNull()
    expect(namedGitBranch('HEAD')).toBeNull()
    expect(namedGitBranch(' HEAD ')).toBeNull()
  })

  it('keeps real branch names', () => {
    expect(namedGitBranch('main')).toBe('main')
    expect(namedGitBranch(' feature/x ')).toBe('feature/x')
  })
})

describe('runTitle', () => {
  function run(goal: string | undefined): RunSummary {
    return {
      runId: 'abcdefgh-1234',
      goal,
      status: 'done',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  }

  it('strips markdown headings from sidebar titles', () => {
    expect(stripGoalMarkdown('### You may launch agents')).toBe('You may launch agents')
    expect(runTitle(run('### You may launch agents now please'))).toBe(
      'You may launch agents now please'
    )
    expect(runTooltip(run('### You may launch agents')).startsWith('You may')).toBe(true)
  })

  it('does not hard-slice long titles (CSS truncate + tooltip handle overflow)', () => {
    const long =
      'You may launch multiple parallel agents concurrently and keep going forever'
    expect(runTitle(run(long))).toBe(long)
    expect(runTooltip(run(long))).toBe(long)
  })

  it('falls back to runId when goal missing', () => {
    expect(runTitle(run(undefined))).toBe('abcdefgh')
  })

  it('search text matches stripped display title', () => {
    const goal = '### Fix login flow'
    expect(runSearchText(run(goal))).toBe('fix login flow')
    expect(runSearchText(run(goal)).includes('fix login')).toBe(true)
  })
})
