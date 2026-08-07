/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, within, waitFor, act } from '@testing-library/react'
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
      data: {
        models: [
          {
            id: 'gpt-5.6',
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsTools: true,
            supportsVision: false
          }
        ],
        warning: 'seed'
      }
    }))
  }
})

describe('Composer', () => {
  it('uses custom model menu not select', () => {
    const onProviderModel = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        chatSettings={{ ...chatSettings, provider: 'ollama', model: 'qwen2.5' }}
        onChatSettingsChange={vi.fn()}
        onProviderModel={onProviderModel}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    expect(document.querySelector('select')).toBeNull()
    const modelBtn = screen.getByRole('button', { name: /Select model/i })
    act(() => {
      fireEvent.click(modelBtn)
    })
    const listbox = screen.getByRole('listbox')
    act(() => {
      fireEvent.click(within(listbox).getByText('llama3.2'))
    })
    expect(onProviderModel).toHaveBeenCalledWith('ollama', 'llama3.2')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('restores composer draft when send reports failure', async () => {
    const onSend = vi.fn(async () => false)
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )

    const ta = screen.getByRole('textbox', { name: /^Message$/i })
    ta.textContent = 'keep me'
    fireEvent.input(ta)
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('keep me', undefined, undefined, undefined)
    })
    await waitFor(() => {
      expect(ta.textContent).toBe('keep me')
    })
  })

  it('filters seed model menu for vision when images are attached', async () => {
    // @ts-expect-error test bridge
    window.vyotiq.listModels = vi.fn(async () => ({
      ok: false as const,
      error: 'offline'
    }))
    render(
      <Composer
        provider="openai"
        model="gpt-5.6"
        running={false}
        hasWorkspace
        chatSettings={{ ...chatSettings, provider: 'openai', model: 'gpt-5.6' }}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['pixels'], 'shot.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)

    await waitFor(() => {
      expect(screen.getByText(/Image 1/i)).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    const listbox = screen.getByRole('listbox')
    // Offline → OpenAI seeds; all mid-2026 seeds are vision-capable.
    expect(within(listbox).getByText('gpt-5.6')).toBeTruthy()
    expect(within(listbox).getByText('gpt-5.6-terra')).toBeTruthy()
  })

  it('attaches a document and sends its extracted text', async () => {
    const extractAttachment = vi.fn(async () => ({
      ok: true as const,
      data: { name: 'spec.md', mime: 'text/markdown', text: 'rules here', truncated: false }
    }))
    // @ts-expect-error test bridge
    window.vyotiq.extractAttachment = extractAttachment
    const onSend = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['rules here'], 'spec.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)

    await waitFor(() => {
      expect(screen.getByText('spec.md')).toBeTruthy()
    })
    expect(extractAttachment).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        '',
        undefined,
        [{ type: 'file', name: 'spec.md', mime: 'text/markdown', text: 'rules here' }],
        undefined
      )
    })
  })

  it('surfaces the reason a document could not be read', async () => {
    // @ts-expect-error test bridge
    window.vyotiq.extractAttachment = vi.fn(async () => ({
      ok: false as const,
      error: 'scan.pdf has no extractable text (it may be a scan)'
    }))
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)

    await waitFor(() => {
      expect(screen.getByText(/no extractable text/i)).toBeTruthy()
    })
  })

  it('keeps composer editable while a run is in progress and shows Stop only', () => {
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    const ta = screen.getByRole('textbox', { name: /^Message$/i })
    expect(ta.getAttribute('contenteditable')).toBe('true')
    expect(screen.getByRole('button', { name: /^Stop$/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Send follow-up$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Send$/i })).toBeNull()
  })

  it('queues follow-ups via Enter while running without a Send button', async () => {
    const onSend = vi.fn(async () => true)
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )

    const ta = screen.getByRole('textbox', { name: /^Message$/i })
    ta.textContent = 'steer left'
    fireEvent.input(ta)
    fireEvent.keyDown(ta, { key: 'Enter', code: 'Enter' })

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('steer left', undefined, undefined, undefined)
    })
  })

  it('shows queued follow-ups with edit, send now, and remove', async () => {
    const onRemoveFollowUp = vi.fn()
    const onEditFollowUp = vi.fn().mockResolvedValue(true)
    const onSendFollowUpNow = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        pendingFollowUps={[
          { id: 'fu-1', itemId: 'item-1', preview: 'Steer left', text: 'Steer left' }
        ]}
        onRemoveFollowUp={onRemoveFollowUp}
        onEditFollowUp={onEditFollowUp}
        onSendFollowUpNow={onSendFollowUpNow}
      />
    )

    expect(screen.getByText('Steer left')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Edit queued follow-up$/i }))
    const editor = screen.getByRole('textbox', { name: /^Edit queued follow-up$/i })
    fireEvent.change(editor, { target: { value: 'Steer right' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save queued follow-up edit$/i }))
    await waitFor(() => {
      expect(onEditFollowUp).toHaveBeenCalledWith('fu-1', 'Steer right')
    })

    fireEvent.click(screen.getByRole('button', { name: /^Send queued follow-up now$/i }))
    expect(onSendFollowUpNow).toHaveBeenCalledWith('fu-1')

    fireEvent.click(screen.getByRole('button', { name: /^Remove queued follow-up$/i }))
    expect(onRemoveFollowUp).toHaveBeenCalledWith('fu-1')
  })

  it('keeps queued follow-up editor open when save fails', async () => {
    const onEditFollowUp = vi.fn().mockResolvedValue(false)
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        pendingFollowUps={[
          { id: 'fu-1', itemId: 'item-1', preview: 'Steer left', text: 'Steer left' }
        ]}
        onEditFollowUp={onEditFollowUp}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Edit queued follow-up$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Save queued follow-up edit$/i }))
    await waitFor(() => {
      expect(onEditFollowUp).toHaveBeenCalledWith('fu-1', 'Steer left')
    })
    expect(screen.getByRole('textbox', { name: /^Edit queued follow-up$/i })).toBeTruthy()
  })

  it('shows reconnecting status while running with network_wait', () => {
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        networkWait={{ attempt: 2, maxAttempts: 5, retryInMs: 1500 }}
      />
    )

    expect(screen.getByText('Reconnecting in 2s (attempt 2/5)…')).toBeTruthy()
  })
})
