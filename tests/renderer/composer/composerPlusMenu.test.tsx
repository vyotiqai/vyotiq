/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'

const chatSettings: EffectiveChatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking
}

function renderComposer() {
  return render(
    <Composer
      provider="ollama"
      model="qwen2.5"
      running={false}
      hasWorkspace
      secrets={emptySecretStatus()}
      chatSettings={chatSettings}
      onChatSettingsChange={vi.fn()}
      onProviderModel={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
      agentMode="agent"
      onAgentModeChange={vi.fn()}
    />
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      listModels: vi.fn(async () => ({ ok: true, data: { models: [], warning: 'seed' } })),
      slashCommandsList: vi.fn().mockResolvedValue({ ok: true, data: { commands: [] } }),
      workspaceSuggestPaths: vi.fn().mockResolvedValue({ ok: true, data: { paths: [], total: 0 } }),
      listRuns: vi.fn().mockResolvedValue({ ok: true, data: { runs: [] } }),
      gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } })
    }
  })
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Composer plus button', () => {
  it('opens the file picker without a modes menu', () => {
    renderComposer()
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const click = vi.spyOn(fileInput, 'click')
    fireEvent.click(screen.getByRole('button', { name: /^Attach files$/i }))
    expect(click).toHaveBeenCalled()
    expect(screen.queryByRole('listbox', { name: /Add to composer/i })).toBeNull()
    expect(screen.queryByRole('option', { name: /Plan/i })).toBeNull()
    expect(screen.queryByRole('option', { name: /Ask/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Agent mode/i })).toBeTruthy()
  })
})
