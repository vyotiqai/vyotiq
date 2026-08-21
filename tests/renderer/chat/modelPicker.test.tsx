/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ModelPicker } from '@renderer/features/chat/components/composer/ModelPicker'
import {
  compactModelLabel,
  type ModelPickerOption
} from '@renderer/features/chat/components/composer/composerModelUtils'

afterEach(() => {
  cleanup()
})

describe('compactModelLabel', () => {
  it('strips a matching provider or group prefix', () => {
    expect(compactModelLabel('OpenAI: GPT-5.6 Luna Pro', 'OpenAI')).toBe('GPT-5.6 Luna Pro')
    expect(compactModelLabel('Qwen: Qwen3.7 Flash', 'OpenRouter', 'Qwen')).toBe('Qwen3.7 Flash')
  })

  it('keeps labels when the prefix does not match', () => {
    expect(compactModelLabel('Claude Opus 5 (Fast)', 'Anthropic')).toBe('Claude Opus 5 (Fast)')
    expect(compactModelLabel('OpenAI: GPT-5.6', 'Anthropic')).toBe('OpenAI: GPT-5.6')
  })
})

const openaiOptions: ModelPickerOption[] = [
  {
    value: 'openai::gpt-5.6',
    label: 'gpt-5.6',
    group: 'OpenAI',
    meta: {
      id: 'gpt-5.6',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsVision: true,
      supportsThinking: true,
      supportedServiceTiers: ['default', 'flex', 'priority']
    }
  },
  {
    value: 'openai::gpt-4.1',
    label: 'gpt-4.1',
    group: 'OpenAI',
    meta: {
      id: 'gpt-4.1',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsVision: false,
      supportsThinking: false
    }
  }
]

const optionsByProvider = {
  openai: openaiOptions,
  anthropic: [
    {
      value: 'anthropic::claude-sonnet-5',
      label: 'claude-sonnet-5',
      group: 'Anthropic',
      meta: {
        id: 'claude-sonnet-5',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: true,
        supportsThinking: true
      }
    }
  ],
  gemini: [],
  ollama: [],
  deepseek: [],
  groq: [],
  openrouter: [],
  xai: [],
  mistral: []
} as Record<import('@shared/ipc').ProviderId, ModelPickerOption[]>

const seedsByProvider = { ...optionsByProvider }

describe('ModelPicker', () => {
  it('opens panel with provider tabs and no agent settings', () => {
    render(
      <ModelPicker
        providers={['openai', 'anthropic']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{ 'openai::gpt-5.6': openaiOptions[0].meta! }}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    expect(screen.getByRole('listbox', { name: /Select model/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /OpenAI/i })).toBeTruthy()
    expect(screen.queryByLabelText(/Max steps/i)).toBeNull()
  })

  it('selects a model without closing requirement enforced by parent', () => {
    const onModelChange = vi.fn()
    render(
      <ModelPicker
        providers={['openai', 'anthropic']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{}}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={onModelChange}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Anthropic$/i }))
    fireEvent.click(screen.getByRole('option', { name: /claude-sonnet-5/i }))
    expect(onModelChange).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5')
  })

  it('shows speed footer for capable models', () => {
    const onServiceTierChange = vi.fn()
    render(
      <ModelPicker
        providers={['openai']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{ 'openai::gpt-5.6': openaiOptions[0].meta! }}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={onServiceTierChange}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Fast\b/i }))
    expect(onServiceTierChange).toHaveBeenCalledWith('priority')
  })

  it('shows empty catalog message when browsed provider has a seed fallback warning', () => {
    render(
      <ModelPicker
        providers={['ollama']}
        optionsByProvider={{ ...optionsByProvider, ollama: [] }}
        seedsByProvider={{ ...seedsByProvider, ollama: [] }}
        modelMetaByValue={{}}
        provider="ollama"
        model="qwen2.5"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{
          ollama:
            'Cannot reach Ollama at http://127.0.0.1:11434. Showing seed defaults (not live models).'
        }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    expect(screen.getByText(/No live models available/i)).toBeTruthy()
    expect(screen.queryByRole('option', { name: /qwen2\.5/i })).toBeNull()
  })

  it('shows catalog warning banner', () => {
    render(
      <ModelPicker
        providers={['openai']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{}}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: 'Using offline model list' }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    expect(screen.getByText(/offline model list/i)).toBeTruthy()
  })

  it('reserves capability badge columns when Think is missing', () => {
    render(
      <ModelPicker
        providers={['openai']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{}}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    const row = screen.getByRole('option', { name: /gpt-4\.1/i })
    const badges = row.querySelector('[data-capability-badges]')
    expect(badges).toBeTruthy()
    const chips = badges!.querySelectorAll(':scope > span')
    expect(chips.length).toBe(3)
    expect(chips[0]!.textContent).toBe('Think')
    expect(chips[0]!.className).toMatch(/invisible/)
    expect(chips[1]!.textContent).toBe('Vision')
    expect(chips[1]!.className).toMatch(/invisible/)
    expect(chips[2]!.textContent).toBe('Tools')
    expect(chips[2]!.className).not.toMatch(/invisible/)
  })

  it('exposes full model label via title on rows', () => {
    render(
      <ModelPicker
        providers={['openai']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{}}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    const row = screen.getByRole('option', { name: /gpt-5\.6/i })
    const label = within(row).getByTitle('gpt-5.6')
    expect(label).toBeTruthy()
    expect(label.className).toMatch(/truncate/)
  })

  it('scrolls the keyboard-active option into view while navigating', () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      render(
        <ModelPicker
          providers={['openai']}
          optionsByProvider={optionsByProvider}
          seedsByProvider={seedsByProvider}
          modelMetaByValue={{}}
          provider="openai"
          model="gpt-5.6"
          favoriteModels={[]}
          recentModels={[]}
          warningsByProvider={{ openai: null, anthropic: null }}
          serviceTier="default"
          onModelChange={vi.fn()}
          onToggleFavorite={vi.fn()}
          onServiceTierChange={vi.fn()}
          onRefreshCatalog={vi.fn()}
          triggerClassName="test-trigger"
        />
      )

      fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
      const search = screen.getByLabelText('Search models')
      expect(scrollIntoView).not.toHaveBeenCalled()

      fireEvent.keyDown(search, { key: 'ArrowDown' })
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      const active = scrollIntoView.mock.instances[0] as HTMLElement
      expect(active.closest('[role="option"]')).toBe(
        screen.getByRole('option', { name: /gpt-5\.6/i })
      )
      expect(scrollIntoView.mock.calls[0]![0]).toEqual({ block: 'nearest' })

      fireEvent.keyDown(search, { key: 'ArrowDown' })
      expect(scrollIntoView).toHaveBeenCalledTimes(2)
      const next = scrollIntoView.mock.instances[1] as HTMLElement
      expect(next.closest('[role="option"]')).toBe(
        screen.getByRole('option', { name: /gpt-4\.1/i })
      )
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})
