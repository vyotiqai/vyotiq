/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PlanPanel, parsePlanOutline, outlineIndentRem } from '@renderer/features/chat/components/PlanPanel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('parsePlanOutline', () => {
  it('skips h1 when deeper headings exist and allocates collision-safe ids', () => {
    const outline = parsePlanOutline(
      '# Title\n\n## Goal\n\n## Goal\n\n### Detail\n\n- [x] done\n- [ ] todo\n'
    )
    expect(outline.headings.map((h) => h.text)).toEqual(['Goal', 'Goal', 'Detail'])
    expect(outline.headings.map((h) => h.level)).toEqual([2, 2, 3])
    // Ids still allocate the h1 slug so they match MarkdownContent headingIds.
    expect(outline.headings.map((h) => h.id)).toEqual(['goal', 'goal-1', 'detail'])
    expect(outline.checked).toBe(1)
    expect(outline.unchecked).toBe(1)
  })

  it('keeps h1 when it is the only heading level', () => {
    const outline = parsePlanOutline('# Solo\n\nBody text here.\n')
    expect(outline.headings).toEqual([{ text: 'Solo', id: 'solo', level: 1 }])
  })

  it('indents relative to the shallowest visible level', () => {
    expect(outlineIndentRem(2, 2)).toBe(0)
    expect(outlineIndentRem(3, 2)).toBe(0.65)
    expect(outlineIndentRem(1, 1)).toBe(0)
  })
})

describe('PlanPanel', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        readRunArtifact: vi.fn(),
        slashCommandsOpenFile: vi.fn()
      }
    })
  })

  it('shows empty contract state when runId is null without calling IPC', async () => {
    render(
      <PlanPanel workspacePath="/ws" runId={null} running={false} />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'contract.md' }))

    await waitFor(() => {
      expect(screen.getByText('No contract yet')).toBeTruthy()
    })
    expect(screen.getByText('The run contract is created when a chat starts.')).toBeTruthy()
    expect(window.vyotiq.readRunArtifact).not.toHaveBeenCalled()
  })

  it('loads contract.md via readRunArtifact when workspace and run are set', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: { name: 'contract.md', exists: true, content: '## Goal\n\nShip it\n' }
    })

    render(
      <PlanPanel workspacePath="/ws" runId="run-1" running={false} />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'contract.md' }))

    await waitFor(() => {
      expect(window.vyotiq.readRunArtifact).toHaveBeenCalledWith({
        workspacePath: '/ws',
        runId: 'run-1',
        name: 'contract.md'
      })
    })
    await waitFor(() => {
      expect(screen.getByText('Ship it')).toBeTruthy()
    })
  })

  it('loads plan.md on mount when draft is ready', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content: '# Comprehensive plan\n\n## Goal\n\nAudit the app\n'
      }
    })

    render(
      <PlanPanel workspacePath="/ws" runId="run-2" running={false} />
    )

    await waitFor(() => {
      expect(window.vyotiq.readRunArtifact).toHaveBeenCalledWith({
        workspacePath: '/ws',
        runId: 'run-2',
        name: 'plan.md'
      })
    })
    await waitFor(() => {
      expect(screen.getByText('Audit the app')).toBeTruthy()
    })
  })

  it('outline click scrolls to matching heading id', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content:
          '# Comprehensive plan\n\n## Scope\n\nDocument the verified scope thoroughly.\n\n## Findings\n\n- [x] first checklist item here\n- [ ] second checklist item here\n'
      }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-outline" running={false} />)

    await waitFor(() => {
      expect(screen.getByLabelText('Plan outline')).toBeTruthy()
    })
    expect(screen.getByText('Outline')).toBeTruthy()
    expect(screen.getByText('Checklist 1/2')).toBeTruthy()
    // H1 omitted from nav when H2s exist.
    const outline = screen.getByLabelText('Plan outline')
    expect(within(outline).queryByRole('button', { name: 'Comprehensive plan' })).toBeNull()

    fireEvent.click(within(outline).getByRole('button', { name: 'Findings' }))

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled()
    })
    expect(document.getElementById('findings')).toBeTruthy()
  })

  it('loads and renders receipt.json summary', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'receipt.json',
        exists: true,
        content: JSON.stringify({
          version: 5,
          writtenAt: '2026-07-30T00:00:00.000Z',
          runId: 'run-3',
          status: 'error',
          statusError: 'Insufficient Balance',
          step: 2,
          compactionCount: 0,
          toolStats: { totalCalls: 3, ok: 2, failed: 1, byName: {} },
          failureClusters: [{ key: 'edit: boom', count: 1 }],
          unreadEditPaths: ['contract.md'],
          wroteFiles: ['AGENTS.md'],
          diagnostics: { calls: 0, ok: 0, clean: 0 },
          contractExcerpt: '## Done when\n\n- Ship it',
          tokenUsage: {
            billedInputTokens: 100,
            inputTokens: 50,
            outputTokens: 10,
            reasoningTokens: 5
          }
        })
      }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-err" running={false} />)
    fireEvent.click(screen.getByRole('tab', { name: 'receipt.json' }))

    await waitFor(() => {
      expect(screen.getByText('Insufficient Balance')).toBeTruthy()
    })
    const badge = screen.getByText('error')
    expect(badge.getAttribute('data-receipt-status')).toBe('error')
    expect(badge.className).toMatch(/text-danger/)
    expect(screen.getByText(/Done when/)).toBeTruthy()
    expect(screen.getByText('billed in')).toBeTruthy()

    const openFile = window.vyotiq.slashCommandsOpenFile as ReturnType<typeof vi.fn>
    fireEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }))
    expect(openFile).toHaveBeenCalledWith({
      workspacePath: '/ws',
      path: 'AGENTS.md'
    })
  })

  it('ignores stale tab responses when switching tabs quickly', async () => {
    let resolvePlan: ((v: unknown) => void) | undefined
    const planPromise = new Promise((resolve) => {
      resolvePlan = resolve
    })
    window.vyotiq.readRunArtifact = vi.fn().mockImplementation(({ name }) => {
      if (name === 'plan.md') return planPromise
      return Promise.resolve({
        ok: true,
        data: { name: 'contract.md', exists: true, content: '## Goal\n\nContract win\n' }
      })
    })

    render(<PlanPanel workspacePath="/ws" runId="run-race" running={false} />)

    fireEvent.click(screen.getByRole('tab', { name: 'contract.md' }))

    await waitFor(() => {
      expect(screen.getByText('Contract win')).toBeTruthy()
    })

    resolvePlan?.({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content: '# Comprehensive plan\n\n## Goal\n\nStale plan text\n'
      }
    })

    await waitFor(() => {
      expect(screen.queryByText('Stale plan text')).toBeNull()
      expect(screen.getByText('Contract win')).toBeTruthy()
    })
    expect(screen.getByLabelText('Contract panel')).toBeTruthy()
  })

  it('hides a prior done receipt while the run is live', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'receipt.json',
        exists: true,
        content: JSON.stringify({
          version: 5,
          writtenAt: '2026-07-30T00:00:00.000Z',
          runId: 'run-stale',
          status: 'done',
          invokeId: 1,
          step: 2,
          compactionCount: 0,
          toolStats: { totalCalls: 1, ok: 1, failed: 0, byName: {} },
          failureClusters: [],
          unreadEditPaths: [],
          wroteFiles: [],
          diagnostics: { calls: 0, ok: 0, clean: 0 },
          contractExcerpt: ''
        })
      }
    })

    render(
      <PlanPanel workspacePath="/ws" runId="run-stale" running invokeId={2} />
    )
    fireEvent.click(screen.getByRole('tab', { name: 'receipt.json' }))

    await waitFor(() => {
      expect(window.vyotiq.readRunArtifact).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByText('Receipt updating')).toBeTruthy()
    })
    expect(
      screen.getByText(/Prior receipt is hidden while this run is live/)
    ).toBeTruthy()
  })

  it('hides a receipt when invokeId mismatches a live run', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'receipt.json',
        exists: true,
        content: JSON.stringify({
          version: 5,
          writtenAt: '2026-07-30T00:00:00.000Z',
          runId: 'run-mismatch',
          status: 'running',
          invokeId: 1,
          step: 1,
          compactionCount: 0,
          toolStats: { totalCalls: 0, ok: 0, failed: 0, byName: {} },
          failureClusters: [],
          unreadEditPaths: [],
          wroteFiles: [],
          diagnostics: { calls: 0, ok: 0, clean: 0 },
          contractExcerpt: ''
        })
      }
    })

    render(
      <PlanPanel workspacePath="/ws" runId="run-mismatch" running invokeId={2} />
    )
    fireEvent.click(screen.getByRole('tab', { name: 'receipt.json' }))

    await waitFor(() => {
      expect(screen.getByText('Receipt updating')).toBeTruthy()
    })
  })

  it('rejects invalid receipt.json via safeParse', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'receipt.json',
        exists: true,
        content: JSON.stringify({ version: 1, runId: 'bad' })
      }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-bad" running={false} />)
    fireEvent.click(screen.getByRole('tab', { name: 'receipt.json' }))

    await waitFor(() => {
      expect(screen.getByText('Invalid receipt.json')).toBeTruthy()
    })
  })

  it('does not poll while inactive even when the agent is running', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content: '# Comprehensive plan\n\n## Goal\n\nShip it\n'
      }
    })

    const pollCalls = (): number =>
      setIntervalSpy.mock.calls.filter((args) => args[1] === 2000).length

    const { rerender } = render(
      <PlanPanel workspacePath="/ws" runId="run-poll" running active={false} />
    )

    await waitFor(() => {
      expect(window.vyotiq.readRunArtifact).toHaveBeenCalled()
    })
    expect(pollCalls()).toBe(0)

    rerender(<PlanPanel workspacePath="/ws" runId="run-poll" running active />)
    await waitFor(() => {
      expect(pollCalls()).toBeGreaterThan(0)
    })
  })
})
