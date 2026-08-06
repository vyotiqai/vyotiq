/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TurnSummary } from '@renderer/features/chat/components/TurnSummary'

describe('TurnSummary', () => {
  it('shows a failure label when the turn span failed', () => {
    render(
      <TurnSummary
        span={{
          startedAt: 1_000,
          endedAt: 5_000,
          active: false,
          failed: true,
          failureLabel: 'Connection lost'
        }}
        collapsed={false}
        onToggle={() => undefined}
      />
    )

    expect(screen.getByText(/Connection lost · 4s/)).toBeTruthy()
  })
})
