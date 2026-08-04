/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChangesPanel } from '@renderer/features/chat/components/ChangesPanel'
import { DockTabBar, defaultDockTab } from '@renderer/features/chat/components/DockTabBar'
import { PrPanel } from '@renderer/features/chat/components/PrPanel'

beforeEach(() => {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      gitStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          kind: 'ok',
          status: {
          branch: 'main',
          files: [
            {
              path: 'src/a.ts',
              status: 'modified',
              added: 3,
              removed: 1,
              addedStaged: 2,
              removedStaged: 0,
              addedUnstaged: 1,
              removedUnstaged: 1,
              binary: false,
              staged: true,
              unstaged: true
            },
            {
              path: 'gone.ts',
              status: 'deleted',
              added: 0,
              removed: 4,
              addedStaged: 0,
              removedStaged: 4,
              addedUnstaged: 0,
              removedUnstaged: 0,
              binary: false,
              staged: true,
              unstaged: false
            },
            {
              path: 'new.ts',
              status: 'untracked',
              added: 2,
              removed: 0,
              addedStaged: 0,
              removedStaged: 0,
              addedUnstaged: 2,
              removedUnstaged: 0,
              binary: false,
              staged: false,
              unstaged: true
            }
          ],
          truncated: false,
          fileCount: 3,
          added: 5,
          removed: 5,
          hasRemote: true,
          hasCommits: true
          }
        }
      }),
      gitCommit: vi.fn().mockResolvedValue({
        ok: true,
        data: { committed: true, pushed: true, detail: 'pushed' }
      }),
      gitStageAll: vi.fn().mockResolvedValue({
        ok: true,
        data: { staged: true, detail: 'Staged all changes' }
      }),
      gitStagePaths: vi.fn().mockResolvedValue({
        ok: true,
        data: { staged: true, detail: 'Staged path' }
      }),
      gitUnstagePaths: vi.fn().mockResolvedValue({
        ok: true,
        data: { unstaged: true, detail: 'Unstaged path' }
      }),
      gitBranches: vi.fn().mockResolvedValue({
        ok: true,
        data: [{ name: 'main', current: true }]
      }),
      gitCheckout: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Checked out main' } }),
      gitLog: vi.fn().mockResolvedValue({
        ok: true,
        data: [
          {
            sha: 'abc1234567890',
            shortSha: 'abc1234',
            subject: 'first',
            author: 'dev',
            relativeDate: '1 day ago'
          }
        ]
      }),
      gitCommitFiles: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          files: [
            {
              path: 'src/a.ts',
              status: 'modified',
              added: 1,
              removed: 0,
              addedStaged: 0,
              removedStaged: 0,
              addedUnstaged: 1,
              removedUnstaged: 0,
              binary: false,
              staged: false,
              unstaged: false
            }
          ]
        }
      }),
      gitDiff: vi.fn().mockResolvedValue({
        ok: true,
        data: { content: '@@ -1 +1 @@\n-old\n+new\n' }
      }),
      prView: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          number: 10,
          title: 'feat: panels',
          url: 'https://github.com/ex/repo/pull/10',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'feat/panels',
          baseRefOid: 'aaa',
          headRefOid: 'bbb',
          body: 'Hello',
          additions: 10,
          deletions: 2,
          files: [{ path: 'a.ts', additions: 10, deletions: 2, changeType: 'MODIFIED' }],
          commits: [{ oid: 'abc1234', messageHeadline: 'feat', authors: ['dev'] }],
          checks: [{ name: 'ci', state: 'SUCCESS', conclusion: 'SUCCESS' }],
          reviews: [],
          latestReviews: [],
          reviewDecision: '',
          reviewRequests: []
        }
      }),
      prMerge: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'merged' } }),
      prDiff: vi.fn().mockResolvedValue({
        ok: true,
        data: { content: '@@ -1 +1 @@\n-old\n+new\n' }
      }),
      prClose: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'closed' } }),
      prEditTitle: vi.fn().mockResolvedValue({ ok: true, data: { title: 'feat: panels' } }),
      githubAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          ghAvailable: true,
          clientIdConfigured: false,
          hasAppToken: false,
          pending: false,
          userCode: null,
          verificationUri: null,
          error: null
        }
      }),
      githubAuthStart: vi.fn(),
      githubAuthCancel: vi.fn(),
      githubAuthLogout: vi.fn(),
      shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: true })
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ChangesPanel', () => {
  it('renders git dirty files from gitStatus', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    expect((await screen.findAllByText('a.ts')).length).toBeGreaterThan(0)
    expect(screen.getByText(/Commit & Push/)).toBeTruthy()
  })

  it('includes deleted files in Staged scope and excludes untracked', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Staged/i }))
    expect((await screen.findAllByText('gone.ts')).length).toBeGreaterThan(0)
    expect(screen.queryByText('new.ts')).toBeNull()
  })

  it('passes staged:true to gitDiff when expanded under Staged scope', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Staged/i }))
    const rows = await screen.findAllByText('a.ts')
    fireEvent.click(rows[0]!)
    await waitFor(() => {
      expect(window.vyotiq.gitDiff).toHaveBeenCalledWith({
        workspacePath: '/ws',
        path: 'src/a.ts',
        staged: true,
        ignoreWhitespace: false,
        sha: undefined
      })
    })
  })

  it('shows a single-column files list', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    expect(screen.queryByText('Tree')).toBeNull()
    expect(screen.getByText(/Files Changed/i)).toBeTruthy()
  })

  it('exposes Layout, Ignore Whitespace, and Find in the more menu', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /More changes actions/i }))
    expect(screen.getByText(/Layout/i)).toBeTruthy()
    expect(screen.getByRole('switch', { name: /Ignore Whitespace/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Find in Changes/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Find in Changes/i }))
    expect(screen.getByRole('searchbox', { name: /Find in changes/i })).toBeTruthy()
  })

  it('lists commits from gitLog under Commits scope', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Commits/i }))
    expect(await screen.findByText('first')).toBeTruthy()
    expect(window.vyotiq.gitLog).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /All Commits/i })).toBeTruthy()
  })

  it('primary Commit & Push sends push:true after composing', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Commit & Push/i }))
    const input = await screen.findByRole('textbox', { name: /Commit message/i })
    fireEvent.change(input, { target: { value: 'ship it' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit & Push$/i }))
    await waitFor(() => {
      expect(window.vyotiq.gitCommit).toHaveBeenCalledWith('/ws', 'ship it', true, 'all')
    })
  })

  it('Staged scope commits without staging all', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Staged/i }))
    fireEvent.click(screen.getByRole('button', { name: /Commit & Push/i }))
    const input = await screen.findByRole('textbox', { name: /Commit message/i })
    fireEvent.change(input, { target: { value: 'staged only' } })
    fireEvent.click(screen.getByRole('button', { name: /^Commit$/i }))
    await waitFor(() => {
      expect(window.vyotiq.gitCommit).toHaveBeenCalledWith('/ws', 'staged only', false, 'staged')
    })
  })

  it('Unstaged scope exposes Stage All', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    await screen.findAllByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Unstaged/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Stage All$/i }))
    await waitFor(() => {
      expect(window.vyotiq.gitStageAll).toHaveBeenCalledWith('/ws')
    })
  })

  it('shows not-a-repo empty state when gitStatus is not_repo', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { kind: 'not_repo' }
    })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    expect(await screen.findByText('Not a git repository')).toBeTruthy()
  })

  it('prefers agent ChangeSummary when not_repo and agent edits exist', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { kind: 'not_repo' }
    })
    const items = [
      { kind: 'message' as const, id: 'u1', role: 'user' as const, content: 'edit', at: 1 },
      {
        kind: 'tool' as const,
        id: 'e1',
        at: 2,
        tool: {
          toolCallId: 'e1',
          name: 'edit',
          status: 'done' as const,
          summary: 'agent-only.ts',
          argsPreview: JSON.stringify({ path: 'agent-only.ts', contents: 'hello\n' })
        }
      }
    ]
    render(<ChangesPanel items={items} workspacePath="/ws" gitRevision={1} />)
    expect(await screen.findByText('agent-only.ts')).toBeTruthy()
    expect(screen.getByText(/1 File Changed/i)).toBeTruthy()
    expect(screen.queryByText('Not a git repository')).toBeNull()
    expect(screen.queryByText(/Agent edits/i)).toBeNull()
    expect(screen.getByRole('button', { name: /Last Agent Turn/i })).toBeTruthy()
  })

  it('shows git-not-found empty state when git is unavailable', async () => {
    ;(window.vyotiq.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { kind: 'unavailable', detail: 'Git is not installed or not on PATH' }
    })
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} />)
    expect(await screen.findByText('Git not found')).toBeTruthy()
    expect(screen.getByText(/not on PATH/i)).toBeTruthy()
  })

  it('applies preferredScope agent when preferredScopeToken bumps', async () => {
    const { rerender } = render(
      <ChangesPanel
        items={[]}
        workspacePath="/ws"
        gitRevision={1}
        preferredScope="uncommitted"
        preferredScopeToken={0}
      />
    )
    await screen.findAllByText('a.ts')
    expect(screen.getByRole('button', { name: /Uncommitted/i })).toBeTruthy()
    rerender(
      <ChangesPanel
        items={[]}
        workspacePath="/ws"
        gitRevision={1}
        preferredScope="agent"
        preferredScopeToken={1}
      />
    )
    expect(await screen.findByRole('button', { name: /Last Agent Turn/i })).toBeTruthy()
  })
})

describe('DockTabBar', () => {
  it('selects tabs and opens missing panels from the add menu', () => {
    const onSelect = vi.fn()
    const onOpenPanel = vi.fn()
    const onCloseTab = vi.fn()
    const onToggleExpanded = vi.fn()
    render(
      <DockTabBar
        active="changes"
        tabs={[defaultDockTab('changes'), defaultDockTab('terminal')]}
        onSelect={onSelect}
        onCloseTab={onCloseTab}
        onOpenPanel={onOpenPanel}
        expanded={false}
        onToggleExpanded={onToggleExpanded}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Terminal$/i }))
    expect(onSelect).toHaveBeenCalledWith('terminal')
    fireEvent.click(screen.getByRole('button', { name: /Open panel/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Browser/i }))
    expect(onOpenPanel).toHaveBeenCalledWith('browser')
    fireEvent.click(screen.getByRole('button', { name: /Close Changes/i }))
    expect(onCloseTab).toHaveBeenCalledWith('changes')
    fireEvent.click(screen.getByRole('button', { name: /Expand panel/i }))
    expect(onToggleExpanded).toHaveBeenCalled()
  })

  it('immersive layout hugs tabs, exposes drag spacer, and keeps Add panel next to tabs', () => {
    const onSelect = vi.fn()
    render(
      <DockTabBar
        variant="immersive"
        active="agent"
        tabs={[
          { id: 'agent', label: 'Agent', icon: 'bot', closable: false },
          defaultDockTab('terminal')
        ]}
        onSelect={onSelect}
        onCloseTab={vi.fn()}
        onOpenPanel={vi.fn()}
        expanded
        onToggleExpanded={vi.fn()}
      />
    )
    const bar = document.querySelector('[data-dock-tab-variant="immersive"]')
    const tablist = bar?.querySelector('[role="tablist"]')
    expect(tablist?.className).not.toMatch(/\bflex-1\b/)
    expect(bar?.querySelector('[data-titlebar-drag-spacer]')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Add panel$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Add panel$/i }))
    expect(screen.getByRole('menuitem', { name: /Browser/i })).toBeTruthy()
  })
})

describe('PrPanel', () => {
  it('renders PR metadata from gh view', async () => {
    const onPrMeta = vi.fn()
    render(<PrPanel workspacePath="/ws" onPrMeta={onPrMeta} />)
    expect(await screen.findByText(/feat: panels/)).toBeTruthy()
    expect(screen.getByText(/feat\/panels → main/)).toBeTruthy()
    expect(onPrMeta).toHaveBeenCalledWith({ number: 10, title: 'feat: panels' })
  })

  it('does not re-fetch when only onPrMeta identity changes', async () => {
    const { rerender } = render(
      <PrPanel workspacePath="/ws" onPrMeta={() => undefined} />
    )
    await screen.findByText(/feat: panels/)
    const calls = (window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length
    rerender(<PrPanel workspacePath="/ws" onPrMeta={() => undefined} />)
    await waitFor(() => {
      expect((window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
    })
  })

  it('reloads when gitRevision bumps', async () => {
    const { rerender } = render(<PrPanel workspacePath="/ws" gitRevision={0} />)
    await screen.findByText(/feat: panels/)
    const calls = (window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length
    rerender(<PrPanel workspacePath="/ws" gitRevision={1} />)
    await waitFor(() => {
      expect((window.vyotiq.prView as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        calls
      )
    })
  })

  it('titles empty state for missing GitHub CLI', async () => {
    ;(window.vyotiq.prView as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'GitHub CLI (gh) is not installed or not on PATH'
    })
    render(<PrPanel workspacePath="/ws" />)
    expect(await screen.findByText('GitHub CLI not found')).toBeTruthy()
  })

  it('calls prMerge for Squash & Merge after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    expect(screen.getByText('Open')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Squash & Merge/i }))
    expect(confirm).toHaveBeenCalled()
    expect(window.vyotiq.prMerge).toHaveBeenCalledWith('/ws', 'squash')
  })

  it('skips prMerge when confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    fireEvent.click(screen.getByRole('button', { name: /Squash & Merge/i }))
    expect(window.vyotiq.prMerge).not.toHaveBeenCalled()
  })

  it('exposes Reviews tab and expandable file diffs with viewed checkbox', async () => {
    render(<PrPanel workspacePath="/ws" />)
    await screen.findByText(/feat: panels/)
    expect(screen.getByRole('button', { name: /^Reviews/i })).toBeTruthy()
    fireEvent.click(screen.getAllByText('a.ts')[0]!)
    await waitFor(() => {
      expect(window.vyotiq.prDiff).toHaveBeenCalledWith({
        workspacePath: '/ws',
        path: 'a.ts',
        ignoreWhitespace: false
      })
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /Mark a\.ts as viewed/i }))
    expect(
      (screen.getByRole('checkbox', { name: /Mark a\.ts as viewed/i }) as HTMLInputElement).checked
    ).toBe(true)
  })

  it('shows Expand All, Find in Diff, Edit Title, Close PR, Unlink PR in ··· menu', async () => {
    const onUnlink = vi.fn()
    render(<PrPanel workspacePath="/ws" onUnlink={onUnlink} />)
    await screen.findByText(/feat: panels/)
    fireEvent.click(screen.getByRole('button', { name: /PR actions/i }))
    expect(screen.getByRole('button', { name: /Expand All Files/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Collapse All/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /View on Web/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Find in Diff/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Edit Title/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Close PR/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Unlink PR/i }))
    expect(onUnlink).toHaveBeenCalled()
  })
})
