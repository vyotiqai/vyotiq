/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer/Composer'
import { mentionMarker } from '@renderer/features/chat/components/composer/mentionModel'

const slashCommands = [
  {
    id: 'builtin:compact',
    trigger: 'compact',
    label: 'Compact context',
    description: 'Summarize older messages',
    kind: 'builtin' as const,
    group: 'App',
    availability: 'ready' as const
  },
  {
    id: 'skill:code-review',
    trigger: 'code-review',
    label: 'code-review',
    description: 'Review diffs',
    kind: 'skill' as const,
    group: 'Skills',
    availability: 'ready' as const,
    packageId: 'code-review'
  }
]

beforeEach(() => {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      slashCommandsList: vi.fn().mockResolvedValue({ ok: true, data: { commands: slashCommands } }),
      slashCommandsResolve: vi.fn().mockImplementation(async (payload: { id: string }) => {
        if (payload.id === 'builtin:compact') {
          return { ok: true, data: { action: 'client', clientAction: 'compact' } }
        }
        if (payload.id === 'skill:code-review') {
          return {
            ok: true,
            data: {
              action: 'send',
              message:
                '[Skill: code-review]\n\n<skill instructions>\n<body>\n</skill instructions>\n\nUser request:\n(no additional instructions)'
            }
          }
        }
        return { ok: false, error: 'unknown' }
      }),
      listModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [] } })
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const baseProps = {
  provider: 'ollama' as const,
  model: 'qwen2.5',
  running: false,
  hasWorkspace: true,
  workspacePath: null as string | null,
  draft: '',
  onDraftChange: vi.fn(),
  onProviderModel: vi.fn(),
  chatSettings: {
    provider: 'ollama' as const,
    model: 'qwen2.5',
    compactionTriggerRatio: 0.7,
    keepRecentTurns: 12,
    thinkingEnabled: true,
    thinkingEffort: 'medium' as const,
    showThinking: true
  },
  onChatSettingsChange: vi.fn(),
  onSend: vi.fn().mockResolvedValue(true),
  onStop: vi.fn(),
  variant: 'hero' as const
}

describe('Composer slash commands', () => {
  it('does not fetch slash commands until the user types /', async () => {
    render(<Composer {...baseProps} />)
    expect(window.vyotiq.slashCommandsList).not.toHaveBeenCalled()
  })

  it('opens the slash menu when typing / and filters by query', async () => {
    const onDraftChange = vi.fn()
    const { rerender } = render(<Composer {...baseProps} draft="" onDraftChange={onDraftChange} />)

    const ta = screen.getByRole('textbox', { name: /^Message$/i })
    ta.textContent = '/com'
    fireEvent.input(ta)
    expect(onDraftChange).toHaveBeenCalledWith('/com')

    rerender(<Composer {...baseProps} draft="/com" onDraftChange={onDraftChange} />)
    fireEvent.focus(ta)

    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: /Slash commands/i })).toBeTruthy()
    })
    expect(screen.getByText('/compact')).toBeTruthy()
  })

  it('renders hero composer with message field', () => {
    render(<Composer {...baseProps} />)
    expect(screen.getByRole('textbox', { name: /^Message$/i })).toBeTruthy()
  })

  it('resolves /compact as a client action without sending chat', async () => {
    const onCompact = vi.fn()
    const onSend = vi.fn()
    const onDraftChange = vi.fn()
    const { rerender } = render(
      <Composer
        {...baseProps}
        draft="/compact"
        onDraftChange={onDraftChange}
        onSend={onSend}
        slashHandlers={{ onCompact }}
      />
    )

    await waitFor(() => expect(window.vyotiq.slashCommandsList).toHaveBeenCalled())

    rerender(
      <Composer
        {...baseProps}
        draft="/compact"
        onDraftChange={onDraftChange}
        onSend={onSend}
        slashHandlers={{ onCompact }}
      />
    )

    const form = screen.getByRole('textbox', { name: /^Message$/i }).closest('form')!
    fireEvent.submit(form)

    await waitFor(() => {
      expect(window.vyotiq.slashCommandsResolve).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'builtin:compact' })
      )
    })
    await waitFor(() => expect(onCompact).toHaveBeenCalled())
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps the slash menu open when the query has no matches', async () => {
    const onDraftChange = vi.fn()
    const { rerender } = render(
      <Composer {...baseProps} draft="" onDraftChange={onDraftChange} />
    )

    const ta = screen.getByRole('textbox', { name: /^Message$/i })
    ta.textContent = '/zzzznotacommand'
    fireEvent.input(ta)
    rerender(
      <Composer {...baseProps} draft="/zzzznotacommand" onDraftChange={onDraftChange} />
    )
    fireEvent.focus(ta)

    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: /Slash commands/i })).toBeTruthy()
    })
    expect(screen.getByText('No matches')).toBeTruthy()
  })

  it('resolves a partial skill trigger on form submit via fuzzy prefix', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const onDraftChange = vi.fn()
    const { rerender } = render(
      <Composer
        {...baseProps}
        draft="/cod"
        onDraftChange={onDraftChange}
        onSend={onSend}
      />
    )

    await waitFor(() => expect(window.vyotiq.slashCommandsList).toHaveBeenCalled())

    rerender(
      <Composer
        {...baseProps}
        draft="/cod"
        onDraftChange={onDraftChange}
        onSend={onSend}
      />
    )

    const form = screen.getByRole('textbox', { name: /^Message$/i }).closest('form')!
    fireEvent.submit(form)

    await waitFor(() => {
      expect(window.vyotiq.slashCommandsResolve).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'skill:code-review' })
      )
    })
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0]?.[0]).toContain('[Skill: code-review]')
  })

  it('inserts a skill chip on menu pick without sending', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const onDraftChange = vi.fn()
    const { rerender } = render(
      <Composer
        {...baseProps}
        draft="/code-review"
        onDraftChange={onDraftChange}
        onSend={onSend}
      />
    )

    await waitFor(() => expect(window.vyotiq.slashCommandsList).toHaveBeenCalled())

    const prefixed = 'hello /code-review'
    rerender(
      <Composer
        {...baseProps}
        draft={prefixed}
        onDraftChange={onDraftChange}
        onSend={onSend}
      />
    )

    const ta = screen.getByRole('textbox', { name: /^Message$/i })
    ta.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(ta)
    range.collapse(false)
    sel?.removeAllRanges()
    sel?.addRange(range)
    fireEvent.click(ta)

    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: /Slash commands/i })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('option', { name: /code-review/i }))

    await waitFor(() => {
      const last = onDraftChange.mock.calls.at(-1)?.[0] as string
      expect(last).toContain('hello ')
      expect(last).toMatch(/\uFFF9slash:skill:/)
      expect(last).toContain('code-review')
      expect(last.endsWith(' ')).toBe(true)
      expect(last).not.toContain('/code-review')
    })
    expect(onSend).not.toHaveBeenCalled()
    expect(window.vyotiq.slashCommandsResolve).not.toHaveBeenCalled()
  })

  it('inserts a builtin command chip on menu pick without sending', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const onDraftChange = vi.fn()
    const { rerender } = render(
      <Composer {...baseProps} draft="/compact" onDraftChange={onDraftChange} onSend={onSend} />
    )

    await waitFor(() => expect(window.vyotiq.slashCommandsList).toHaveBeenCalled())

    rerender(
      <Composer {...baseProps} draft="/compact" onDraftChange={onDraftChange} onSend={onSend} />
    )

    const ta = screen.getByRole('textbox', { name: /^Message$/i })
    ta.focus()
    fireEvent.click(ta)

    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: /Slash commands/i })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('option', { name: /Compact context/i }))

    await waitFor(() => {
      const last = onDraftChange.mock.calls.at(-1)?.[0] as string
      expect(last).toMatch(/\uFFF9slash:builtin:/)
      expect(last).toContain('compact')
      expect(last.endsWith(' ')).toBe(true)
    })
    expect(onSend).not.toHaveBeenCalled()
    expect(window.vyotiq.slashCommandsResolve).not.toHaveBeenCalled()
  })

  it('inserts a partial skill pick as a chip without sending', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const onDraftChange = vi.fn()
    const { rerender } = render(
      <Composer {...baseProps} draft="/cod" onDraftChange={onDraftChange} onSend={onSend} />
    )

    await waitFor(() => expect(window.vyotiq.slashCommandsList).toHaveBeenCalled())

    rerender(
      <Composer {...baseProps} draft="/cod" onDraftChange={onDraftChange} onSend={onSend} />
    )

    const ta = screen.getByRole('textbox', { name: /^Message$/i })
    ta.focus()
    fireEvent.click(ta)

    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: /Slash commands/i })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('option', { name: /code-review/i }))

    await waitFor(() => {
      const last = onDraftChange.mock.calls.at(-1)?.[0] as string
      expect(last).toMatch(/^\uFFF9slash:skill:/)
      expect(last).toContain('code-review')
      expect(last.endsWith(' ')).toBe(true)
    })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('resolves a skill chip on submit after loading catalog (no prior / menu)', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const onDraftChange = vi.fn()
    const chipDraft = `${mentionMarker({
      kind: 'slash',
      slashKind: 'skill',
      trigger: 'code-review',
      commandId: 'skill:code-review'
    })} focus on auth`

    render(
      <Composer
        {...baseProps}
        variant="inline"
        workspacePath="/ws"
        draft={chipDraft}
        onDraftChange={onDraftChange}
        onSend={onSend}
      />
    )

    await waitFor(() => expect(window.vyotiq.slashCommandsList).toHaveBeenCalled())

    const form = screen.getByRole('textbox', { name: /Edit message|Message/i }).closest('form')
    expect(form).toBeTruthy()
    fireEvent.submit(form!)

    await waitFor(() => {
      expect(window.vyotiq.slashCommandsResolve).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'skill:code-review',
          trailingText: 'focus on auth'
        })
      )
    })
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0]?.[0]).toContain('[Skill: code-review]')
  })

  it('does not strip a skill chip into a plain send when catalog resolve fails', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const onDraftChange = vi.fn()
    vi.mocked(window.vyotiq.slashCommandsList).mockResolvedValue({
      ok: true,
      data: { commands: [] }
    })
    const chipDraft = `${mentionMarker({
      kind: 'slash',
      slashKind: 'skill',
      trigger: 'code-review'
    })} trailing only`

    render(
      <Composer
        {...baseProps}
        variant="inline"
        workspacePath="/ws"
        draft={chipDraft}
        onDraftChange={onDraftChange}
        onSend={onSend}
      />
    )

    await waitFor(() => expect(window.vyotiq.slashCommandsList).toHaveBeenCalled())

    const form = screen.getByRole('textbox', { name: /Edit message|Message/i }).closest('form')
    fireEvent.submit(form!)

    await waitFor(() => {
      expect(window.vyotiq.slashCommandsResolve).not.toHaveBeenCalled()
    })
    // Give the async submit path a tick; must not fall through to plain onSend.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onSend).not.toHaveBeenCalled()
  })
})
