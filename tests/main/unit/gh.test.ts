import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileAsync } = vi.hoisted(() => ({
  execFileAsync: vi.fn()
}))

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>()
  return {
    ...actual,
    promisify: () => execFileAsync
  }
})

vi.mock('child_process', () => ({
  execFile: vi.fn()
}))

import { ghAvailable, prClose, prDiff, prEditTitle, prMerge, prView } from '@main/git/gh'

describe('gh helpers', () => {
  beforeEach(() => {
    execFileAsync.mockReset()
  })

  it('ghAvailable is false when gh is missing', async () => {
    execFileAsync.mockRejectedValueOnce(new Error('not found'))
    await expect(ghAvailable()).resolves.toBe(false)
  })

  it('prView throws when gh is unavailable', async () => {
    execFileAsync.mockRejectedValueOnce(new Error('not found'))
    await expect(prView('/ws')).rejects.toThrow(/GitHub CLI/)
  })

  it('prView returns null for genuine no-PR errors', async () => {
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockRejectedValueOnce(new Error('no pull requests found for branch "feat"'))
    await expect(prView('/ws')).resolves.toBeNull()
  })

  it('prView returns null when cwd is not a git/GitHub repo', async () => {
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: gh pr view --json number'), {
          stderr: 'failed to run git: fatal: not a git repository'
        })
      )
    await expect(prView('/ws')).resolves.toBeNull()
  })

  it('prView returns null when the repo has no git remotes', async () => {
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            'Command failed: gh pr view --json number,title,url,state,baseRefName,headRefName,baseRefOid,headRefOid,body,additions,deletions\nno git remotes found\n'
          ),
          { stderr: 'no git remotes found\n' }
        )
      )
    await expect(prView('/ws')).resolves.toBeNull()
  })

  it('prView falls back when optional JSON fields are unknown', async () => {
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockRejectedValueOnce(new Error('Unknown JSON field: "reviewRequests"'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'Fallback',
          url: 'https://example.com/pr/7',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'feat',
          baseRefOid: 'base',
          headRefOid: 'head',
          body: '',
          additions: 1,
          deletions: 0,
          files: [],
          commits: [],
          statusCheckRollup: []
        }),
        stderr: ''
      })
    const view = await prView('/ws')
    expect(view?.number).toBe(7)
    expect(view?.reviews).toEqual([])
    expect(view?.reviewRequests).toEqual([])
  })

  it('prView maps gh JSON into PrView', async () => {
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 12,
          title: 'Dock WIP',
          url: 'https://example.com/pr/12',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'feat',
          baseRefOid: 'baseoid',
          headRefOid: 'headoid',
          body: 'notes',
          additions: 3,
          deletions: 1,
          files: [{ path: 'a.ts', additions: 3, deletions: 1, changeType: 'ADDED' }],
          commits: [{ oid: 'abc', messageHeadline: 'wip', authors: [{ login: 'u' }] }],
          statusCheckRollup: [{ name: 'ci', state: 'SUCCESS', conclusion: 'SUCCESS' }],
          reviews: [
            {
              author: { login: 'rev' },
              state: 'APPROVED',
              body: 'lgtm',
              submittedAt: '2026-01-01T00:00:00Z'
            }
          ],
          latestReviews: [
            {
              author: { login: 'rev' },
              state: 'APPROVED',
              body: 'lgtm',
              submittedAt: '2026-01-01T00:00:00Z'
            }
          ],
          reviewDecision: 'APPROVED',
          reviewRequests: [{ login: 'alice' }]
        }),
        stderr: ''
      })
    const view = await prView('/ws')
    expect(view?.number).toBe(12)
    expect(view?.files[0]?.path).toBe('a.ts')
    expect(view?.files[0]?.changeType).toBe('ADDED')
    expect(view?.commits[0]?.authors).toEqual(['u'])
    expect(view?.checks[0]?.name).toBe('ci')
    expect(view?.reviews[0]?.author).toBe('rev')
    expect(view?.reviewDecision).toBe('APPROVED')
    expect(view?.reviewRequests).toEqual(['alice'])
    expect(view?.baseRefOid).toBe('baseoid')
  })

  it('prMerge throws when gh is missing', async () => {
    execFileAsync.mockRejectedValueOnce(new Error('not found'))
    await expect(prMerge('/ws', 'squash')).rejects.toThrow(/GitHub CLI/i)
  })

  it('prDiff uses git between base and head OIDs', async () => {
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ baseRefOid: 'aaa', headRefOid: 'bbb' }),
        stderr: ''
      })
      .mockResolvedValueOnce({ stdout: '@@ -1 +1 @@\n+hi\n', stderr: '' })
    const result = await prDiff('/ws', { path: 'a.ts', ignoreWhitespace: true })
    expect(result.content).toContain('+hi')
    const argsList = execFileAsync.mock.calls.map((c) => c[1] as string[] | undefined)
    expect(argsList.some((a) => a?.includes('diff') && a?.includes('--ignore-all-space'))).toBe(
      true
    )
    expect(argsList.some((a) => a?.includes('aaa...bbb'))).toBe(true)
  })

  it('prClose and prEditTitle invoke gh', async () => {
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'closed\n', stderr: '' })
    await expect(prClose('/ws')).resolves.toEqual({ detail: 'closed' })

    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    await expect(prEditTitle('/ws', 'New title')).resolves.toEqual({ title: 'New title' })
  })
})
