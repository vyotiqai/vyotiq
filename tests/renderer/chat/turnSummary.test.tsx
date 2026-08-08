/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TurnSummary } from '@renderer/features/chat/components/TurnSummary'

describe('TurnSummary', () => {
  it('suppresses phase label when live tools own the detail', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now() - 500,
          endedAt: null,
          active: true,
          activity: { kind: 'tool', label: 'Reading', detail: 'file.ts' }
        }}
        collapsed={false}
        suppressPhaseLabel
        onToggle={() => undefined}
      />
    )

    expect(screen.queryByText('Reading')).toBeNull()
    expect(screen.queryByText(/file\.ts/)).toBeNull()
    expect(screen.getByRole('button', { name: /^Collapse turn work$/i })).toBeTruthy()
  })

  it('shows phase shimmer when collapsed during a live turn', () => {
    render(
      <TurnSummary
        span={{
          startedAt: Date.now() - 500,
          endedAt: null,
          active: true,
          activity: { kind: 'tool', label: 'Reading', detail: 'file.ts' }
        }}
        collapsed
        suppressPhaseLabel
        onToggle={() => undefined}
      />
    )

    expect(screen.getByText('Reading file.ts')).toBeTruthy()
  })
})
