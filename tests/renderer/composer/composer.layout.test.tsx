/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'

afterEach(() => {
  cleanup()
})

const chatSettings: EffectiveChatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
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
  secrets: emptySecretStatus(),
  chatSettings,
  onChatSettingsChange: vi.fn(),
  onProviderModel: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn()
}

describe('Composer layout', () => {
  it('places the input full width above the compact toolbar', () => {
    render(<Composer {...composerProps} />)

    const shell = document.querySelector('[data-composer-shell]')
    expect(shell).toBeTruthy()
    const form = shell?.querySelector('form')
    expect(form).toBeTruthy()
    expect(form?.className).toMatch(/\bpx-2\.5\b/)
    expect(form?.className).toMatch(/(?:^|\s)py-1(?:\s|$)/)
    expect(form?.className).not.toMatch(/(?:^|\s)py-1\.5(?:\s|$)/)
    expect(form?.className).toMatch(/(?:^|\s)gap-1(?:\s|$)/)
    expect(form?.className).not.toMatch(/(?:^|\s)gap-1\.5(?:\s|$)/)

    const textarea = screen.getByRole('combobox', { name: /^Message$/i })
    const toolbar = form?.querySelector('[data-composer-toolbar]')
    const plus = screen.getByRole('button', { name: /^Attach files$/i })
    const primary = screen.getByRole('button', { name: /^Dictate$/i })
    expect(toolbar).toBeTruthy()
    expect(toolbar?.contains(textarea)).toBe(false)
    expect(form?.contains(textarea)).toBe(true)
    expect(textarea.className).toMatch(/\bw-full\b/)
    expect(textarea.className).toMatch(/\bmin-h-7\b/)
    expect(toolbar?.contains(plus)).toBe(true)
    expect(toolbar?.contains(primary)).toBe(true)
    expect(toolbar?.className).toMatch(/\bh-7\b/)
    expect(toolbar?.className).toMatch(/(?:^|\s)gap-1(?:\s|$)/)
    expect(toolbar?.className).toMatch(/\bitems-center\b/)
    expect(toolbar?.className).not.toMatch(/border-t/)
    expect(toolbar?.className).not.toMatch(/\bmin-h-8\b/)
    expect(plus.className).toMatch(/\brounded-md\b/)
    expect(primary.className).toMatch(/\brounded-md\b/)
    expect(primary.className).not.toMatch(/\brounded-xl\b/)

    expect(textarea.compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(textarea.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps multiline text full width instead of a side column', () => {
    render(<Composer {...composerProps} />)

    const shell = document.querySelector('[data-composer-shell]')
    const form = shell?.querySelector('form')
    expect(form).toBeTruthy()
    const textarea = screen.getByRole('combobox', { name: /^Message$/i })
    textarea.textContent = 'line one\nline two\nline three\nline four\nline five'
    fireEvent.input(textarea)

    const toolbar = form?.querySelector('[data-composer-toolbar]')
    expect(toolbar?.contains(textarea)).toBe(false)
    expect(textarea.className).toMatch(/\bw-full\b/)
    expect(toolbar?.className).toMatch(/\bitems-center\b/)
    expect(toolbar?.className).not.toMatch(/\bitems-end\b/)
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

  it('keeps the model cluster constrained so the toolbar can flex', () => {
    render(<Composer {...composerProps} />)

    const toolbar = document.querySelector('[data-composer-toolbar]')
    expect(toolbar).toBeTruthy()
    expect(toolbar!.className).toMatch(/\bmin-w-0\b/)
    expect(toolbar!.className).not.toMatch(/border-t/)
    const modelPicker = toolbar!.querySelector('[aria-label="Select model"]')?.parentElement
    expect(modelPicker?.className).toMatch(/\bmin-w-0\b/)
    expect(modelPicker?.className).toMatch(/\bmax-w-\[6rem\]/)
    const mic = screen.getByRole('button', { name: /^Dictate$/i })
    expect(mic.parentElement?.className).toMatch(/\bgap-1\b/)
    expect(mic.parentElement?.className).not.toMatch(/\bgap-0\.5\b/)
  })

  it('keeps git status out of the composer toolbar', () => {
    render(<Composer {...composerProps} />)

    const toolbar = document.querySelector('[data-composer-toolbar]')
    expect(toolbar).toBeTruthy()
    expect(document.querySelector('[data-composer-git-leading]')).toBeNull()
    expect(document.querySelector('[data-composer-git-leading-wrap]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Open Changes panel/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh git status' })).toBeNull()
  })

  it('hides Think below a gutter-aware form breakpoint, not pane min width', () => {
    render(<Composer {...composerProps} />)
    const toolbar = document.querySelector('[data-composer-toolbar]')
    expect(toolbar).toBeTruthy()
    const slot = [...toolbar!.querySelectorAll('div')].find((el) =>
      el.className.includes('@min-[280px]:inline-flex')
    )
    expect(slot).toBeTruthy()
    expect(slot!.className).toMatch(/\bhidden\b/)
    expect(slot!.className).not.toMatch(/@min-\[360px\]/)
  })
})
