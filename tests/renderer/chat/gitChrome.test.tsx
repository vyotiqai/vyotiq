/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useGitChrome, type GitChrome } from '@renderer/features/chat/components/GitChrome'
import { ChatGitLeading, ChatGitTrailing } from '@renderer/features/chat/components/ChatStreamLeaves'
import type { GitStatus } from '@shared/ipc'

const clean: GitStatus = {
  branch: 'main',
  files: [],
  truncated: false,
  fileCount: 0,
  added: 0,
  removed: 0,
  hasRemote: true,
  hasCommits: true
}

const dirty: GitStatus = {
  ...clean,
  files: [
    {
      path: 'src/a.ts',
      status: 'modified',
      added: 10,
      removed: 4,
      addedStaged: 0,
      removedStaged: 0,
      addedUnstaged: 10,
      removedUnstaged: 4,
      binary: false,
      staged: false,
      unstaged: true
    },
    {
      path: 'src/b.ts',
      status: 'untracked',
      added: 7,
      removed: 0,
      addedStaged: 0,
      removedStaged: 0,
      addedUnstaged: 7,
      removedUnstaged: 0,
      binary: false,
      staged: false,
      unstaged: true
    }
  ],
  fileCount: 2,
  added: 17,
  removed: 4
}

/** Leading chrome shares one hook — Changes left, branch right. */
function Harness({
  workspacePath = '/ws',
  onOpenChanges
}: {
  workspacePath?: string | null
  onOpenChanges?: () => void
}) {
  // Non-zero revision skips the production startup defer (revision === 0).
  const chrome = useGitChrome(workspacePath, 1)
  return <ChatGitLeading chrome={chrome} onOpenChanges={onOpenChanges} />
}

function mockApi(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'ok', status: dirty } }),
    gitCommit: vi.fn().mockResolvedValue({
      ok: true,
      data: { committed: true, pushed: false, detail: 'Committed' }
    }),
    gitStageAll: vi.fn().mockResolvedValue({
      ok: true,
      data: { staged: true, detail: 'Staged all changes' }
    }),
    ...overrides
  } as Record<string, ReturnType<typeof vi.fn>>
  Object.defineProperty(window, 'vyotiq', { configurable: true, writable: true, value: api })
  return api
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  mockApi()
})

describe('git chrome', () => {
  it('shows Changes and branch on the leading row', async () => {
    render(<Harness />)

    expect(await screen.findByText('main')).toBeTruthy()
    expect(screen.getByText('Changes')).toBeTruthy()
    expect(screen.getByText('+17')).toBeTruthy()
    expect(screen.getByText('-4')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh git status' })).toBeTruthy()
  })

  it('opens Changes when the compact pill is clicked', async () => {
    const onOpenChanges = vi.fn()
    render(<Harness onOpenChanges={onOpenChanges} />)
    fireEvent.click(await screen.findByRole('button', { name: /Open Changes panel/ }))
    expect(onOpenChanges).toHaveBeenCalled()
  })

  it('labels line deltas on the Changes pill', async () => {
    render(<Harness />)
    const pill = await screen.findByRole('button', {
      name: 'Open Changes panel, 2 files, +17 -4 lines'
    })
    expect(pill.getAttribute('title')).toBe('2 files · +17 / -4 lines')
    expect(pill.textContent).toMatch(/lines/)
  })

  it('shows detached when branch is null or HEAD', async () => {
    mockApi({
      gitStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: { kind: 'ok', status: { ...clean, branch: null } }
      })
    })
    const { unmount } = render(<Harness />)
    expect(await screen.findByText('detached')).toBeTruthy()
    unmount()

    mockApi({
      gitStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: { kind: 'ok', status: { ...clean, branch: 'HEAD' } }
      })
    })
    render(<Harness />)
    expect(await screen.findByText('detached')).toBeTruthy()
  })

  it('renders nothing when the workspace is not a repository', async () => {
    mockApi({ gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } }) })
    const { container } = render(<Harness />)

    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('keeps the branch but drops the change pills on a clean tree', async () => {
    mockApi({ gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'ok', status: clean } }) })
    render(<Harness />)

    expect(await screen.findByText('main')).toBeTruthy()
    expect(screen.queryByText('Changes')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Changes panel' })).toBeNull()
  })

  it('re-reads git when asked', async () => {
    const api = mockApi()
    render(<Harness />)

    await screen.findByText('main')
    expect(api.gitStatus).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh git status' }))
    await waitFor(() => expect(api.gitStatus).toHaveBeenCalledTimes(2))
  })

  it('ChatGitTrailing is a no-op after branch moved to leading', () => {
    const chrome: GitChrome = {
      status: dirty,
      result: { kind: 'ok', status: dirty },
      error: null,
      ready: true,
      loading: false,
      busy: false,
      notice: null,
      noticeFailed: false,
      refresh: vi.fn(),
      commit: vi.fn(),
      stageAll: vi.fn(),
      stagePaths: vi.fn(),
      unstagePaths: vi.fn()
    }
    const { container } = render(<ChatGitTrailing chrome={chrome} />)
    expect(container.textContent).toBe('')
  })
})
