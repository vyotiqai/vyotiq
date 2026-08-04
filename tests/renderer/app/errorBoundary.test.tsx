/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'

afterEach(() => {
  cleanup()
})

function Boom(): never {
  throw new Error('boundary-test-crash')
}

describe('ErrorBoundary', () => {
  it('renders recovery UI on child throw', () => {
    // @ts-expect-error test bridge
    window.vyotiq = {
      openLogsDir: vi.fn(async () => ({ ok: true as const, data: true as const }))
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    spy.mockRestore()

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Something went wrong/i)).toBeTruthy()
    expect(screen.queryByText(/boundary-test-crash/i)).toBeNull()
    expect(screen.getByRole('button', { name: /Try again/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Reload/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open logs/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Open logs/i }))
    expect(window.vyotiq.openLogsDir).toHaveBeenCalled()
  })

  it('clears a caught error when resetKey changes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(
      <ErrorBoundary resetKey="a">
        <Boom />
      </ErrorBoundary>
    )
    spy.mockRestore()

    expect(screen.getByRole('alert')).toBeTruthy()

    rerender(
      <ErrorBoundary resetKey="b">
        <span>recovered</span>
      </ErrorBoundary>
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('recovered')).toBeTruthy()
  })
})
