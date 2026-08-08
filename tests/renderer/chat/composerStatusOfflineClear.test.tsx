/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposerStatus } from '@renderer/features/chat/components/composer/ComposerStatus'

afterEach(() => {
  cleanup()
})

describe('ComposerStatus offline clear', () => {
  it('shows Clear when queued hint and handler are set', () => {
    const onClear = vi.fn()
    render(
      <ComposerStatus
        offlineHint="2 messages queued — will send when online"
        onClearOfflineQueue={onClear}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('hides Clear for network-only offline hint', () => {
    render(
      <ComposerStatus
        offlineHint="You appear to be offline. Agent runs will retry when connectivity returns."
        onClearOfflineQueue={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })
})
