/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TurnSummary } from '@renderer/features/chat/components/TurnSummary'
import type { TurnSpan } from '@renderer/features/chat/utils/transcriptRows'

afterEach(() => {
  cleanup()
})

describe('TurnSummary', () => {
  it('shows phase label when expanded and active', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now() - 3_000,
          endedAt: null,
          active: true,
          activity: { kind: 'thinking' }
        }}
        collapsed={false}
        onToggle={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: /Collapse turn work, Working · 3s/i })).toBeTruthy()
    expect(document.querySelector('.vy-text-shimmer--active')).toBeTruthy()
  })

  it('shows phase label with whole-turn duration when collapsed and active', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now() - 3_000,
          endedAt: null,
          active: true,
          activity: { kind: 'thinking' }
        }}
        collapsed={true}
        onToggle={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: /Thinking · 3s/i })).toBeTruthy()
  })

  it('uses whole-turn duration for a collapsed tool phase', () => {
    const turnStart = Date.now() - 250_000
    render(
      <TurnSummary
        span={{
          startedAt: turnStart,
          endedAt: null,
          active: true,
          activity: { kind: 'tool', label: 'Editing', detail: 'file' }
        }}
        collapsed={true}
        onToggle={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: /Editing file · 4m 10s/i })).toBeTruthy()
  })

  it('keeps the ticking duration outside the shimmer element', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now() - 3_000,
          endedAt: null,
          active: true,
          activity: { kind: 'thinking' }
        }}
        collapsed={true}
        onToggle={() => {}}
      />
    )

    const shimmer = document.querySelector('.vy-text-shimmer--active')
    expect(shimmer?.textContent).toBe('Thinking')
    const button = screen.getByRole('button', { name: /Thinking · 3s/i })
    expect(button.textContent).toContain('· 3s')
    expect(button.textContent).not.toBe(shimmer?.textContent)
  })

  it('shows worked label without shimmer when finished', () => {
    const startedAt = Date.parse('2026-07-25T10:00:00.000Z')
    const endedAt = Date.parse('2026-07-25T10:00:09.000Z')
    render(
      <TurnSummary
        span={{
          startedAt,
          endedAt,
          active: false,
          activity: null
        }}
        collapsed={false}
        onToggle={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: /Worked for 9s/i })).toBeTruthy()
    expect(document.querySelector('.vy-text-shimmer--active')).toBeNull()
  })

  it('shows planning when activity is planning', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now(),
          endedAt: null,
          active: true,
          activity: { kind: 'planning' }
        }}
        collapsed={true}
        onToggle={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: /Planning/i })).toBeTruthy()
  })

  it('shows phase label when expanded before duration is reportable', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now(),
          endedAt: null,
          active: true,
          activity: { kind: 'thinking' }
        }}
        collapsed={false}
        onToggle={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: /Collapse turn work, Working$/i })).toBeTruthy()
  })

  it('shows Writing when expanded while the closing answer streams', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now() - 3_000,
          endedAt: null,
          active: true,
          activity: { kind: 'writing' }
        }}
        collapsed={false}
        onToggle={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: /Collapse turn work, Working · 3s/i })).toBeTruthy()
  })

  it('shows Awaiting approval when expanded during approval', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now(),
          endedAt: null,
          active: true,
          activity: { kind: 'awaiting_approval' }
        }}
        collapsed={false}
        onToggle={() => {}}
      />
    )

    expect(
      screen.getByRole('button', { name: /Collapse turn work, Working$/i })
    ).toBeTruthy()
  })

  it('falls back to Working when expanded with no activity', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now() - 3_000,
          endedAt: null,
          active: true,
          activity: null
        }}
        collapsed={false}
        onToggle={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: /Collapse turn work, Working · 3s/i })).toBeTruthy()
  })
})
