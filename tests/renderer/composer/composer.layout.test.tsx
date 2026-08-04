/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'

afterEach(() => {
  cleanup()
})

const chatSettings: EffectiveChatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  compactionTriggerRatio: DEFAULT_SETTINGS.compactionTriggerRatio,
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking
}

beforeEach(() => {
  // @ts-expect-error test bridge
  window.vyotiq = {
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: { models: [], warning: 'seed' }
    }))
  }
})

const composerProps = {
  provider: 'ollama' as const,
  model: 'qwen2.5',
  running: false,
  chatSettings,
  onChatSettingsChange: vi.fn(),
  onProviderModel: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn()
}

describe('Composer layout', () => {
  it('renders toolbar on its own row below textarea in DOM order', () => {
    render(<Composer {...composerProps} />)

    const shell = document.querySelector('[data-composer-shell]')
    expect(shell).toBeTruthy()

    const textarea = screen.getByRole('textbox', { name: /^Message$/i })
    const toolbar = shell?.querySelector('[data-composer-toolbar]')
    expect(toolbar).toBeTruthy()
    expect(shell?.contains(textarea)).toBe(true)
    expect(shell?.contains(toolbar!)).toBe(true)

    const children = Array.from(shell!.children).filter((el) => el.tagName !== 'INPUT')
    const textareaIdx = children.findIndex((el) => el.contains(textarea))
    const toolbarIdx = children.findIndex((el) => el === toolbar)
    expect(textareaIdx).toBeGreaterThanOrEqual(0)
    expect(toolbarIdx).toBeGreaterThan(textareaIdx)
  })

  it('keeps toolbar after message input when multiline', () => {
    render(<Composer {...composerProps} />)

    const shell = document.querySelector('[data-composer-shell]')
    const textarea = screen.getByRole('textbox', { name: /^Message$/i })
    textarea.textContent = 'line one\nline two\nline three\nline four\nline five'
    fireEvent.input(textarea)

    const toolbar = shell?.querySelector('[data-composer-toolbar]')
    const children = Array.from(shell!.children).filter((el) => el.tagName !== 'INPUT')
    const textareaIdx = children.findIndex((el) => el.contains(textarea))
    const toolbarIdx = children.findIndex((el) => el === toolbar)
    expect(toolbarIdx).toBeGreaterThan(textareaIdx)
  })

  it('places attachments inside the composer shell', async () => {
    render(<Composer {...composerProps} />)

    const shell = document.querySelector('[data-composer-shell]')
    expect(shell).toBeTruthy()

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['pixels'], 'shot.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)

    const chip = await waitFor(() => screen.getByText(/Image 1/i))
    expect(shell?.contains(chip)).toBe(true)
  })
})
