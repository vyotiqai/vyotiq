/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatView } from '@renderer/features/chat/ChatView'
import { emptySecretStatus } from '@shared/ipc'
import type { RunSummary } from '@shared/ipc'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } }),
      browserGetState: vi.fn().mockResolvedValue({
        ok: true,
        data: { open: false, url: '', title: '' }
      }),
      onBrowserState: vi.fn().mockReturnValue(() => undefined),
      readRunArtifact: vi.fn().mockResolvedValue({ ok: true, data: '' })
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function run(id: string, goal: string): RunSummary {
  return { runId: id, status: 'done', updatedAt: '', goal }
}

const baseProps = {
  items: [],
  running: false,
  error: null,
  hasWorkspace: true,
  workspacePath: '/ws',
  provider: 'ollama' as const,
  model: 'qwen2.5',
  activeRunId: null,
  chatSettings: {
    provider: 'ollama' as const,
    model: 'qwen2.5',
    keepRecentTurns: 12,
    thinkingEnabled: true,
    thinkingEffort: 'medium' as const,
    showThinking: true
  },
  onChatSettingsChange: vi.fn(),
  onProviderModel: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  secrets: emptySecretStatus()
}

describe('ChatView in-chat session tabs (non-immersive)', () => {
  it('renders the session tab strip when two or more sessions are open', () => {
    const onOpenRunTab = vi.fn()
    const onCloseRunTab = vi.fn()

    render(
      <ChatView
        {...baseProps}
        activeRunId="r1"
        openRunIds={['r1', 'r2']}
        runs={[run('r1', 'First'), run('r2', 'Second')]}
        onOpenRunTab={onOpenRunTab}
        onCloseRunTab={onCloseRunTab}
      />
    )

    const strip = document.querySelector('[data-chat-session-tabs]')
    expect(strip).not.toBeNull()
    expect(screen.getByText('First')).toBeTruthy()
    expect(screen.getByText('Second')).toBeTruthy()
    expect(screen.getByRole('tablist', { name: /agent sessions/i })).toBeTruthy()
  })

  it('hides the session tab strip when only one session is open', () => {
    render(
      <ChatView
        {...baseProps}
        activeRunId="r1"
        openRunIds={['r1']}
        runs={[run('r1', 'Only')]}
        onOpenRunTab={vi.fn()}
        onCloseRunTab={vi.fn()}
      />
    )

    expect(document.querySelector('[data-chat-session-tabs]')).toBeNull()
  })

  it('does not render the strip when onOpenRunTab is absent', () => {
    render(
      <ChatView
        {...baseProps}
        activeRunId="r1"
        openRunIds={['r1', 'r2']}
        runs={[run('r1', 'First'), run('r2', 'Second')]}
      />
    )

    expect(document.querySelector('[data-chat-session-tabs]')).toBeNull()
  })
})
