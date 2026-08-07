/**
 * @vitest-environment jsdom
 */
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { SettingsView } from '@renderer/features/settings'
import { emptySecretStatus, type Settings } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

const emptySecrets = emptySecretStatus()

const baseSettings: Settings = {
  ...DEFAULT_SETTINGS,
  provider: 'openai',
  model: 'gpt-5.6'
}

beforeEach(() => {
  // @ts-expect-error test bridge
  window.vyotiq = {
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: { models: [{ id: 'gpt-5.6', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false }], warning: 'seed' }
    })),
    openLogsDir: vi.fn(async () => ({ ok: true as const, data: true as const })),
    getLogsPath: vi.fn(async () => ({ ok: true as const, data: '/tmp/logs' })),
    telemetryStatus: vi.fn(async () => ({
      ok: true as const,
      data: { dsnConfigured: false, telemetryEnabled: false }
    })),
    mcpStatus: vi.fn(async () => ({ ok: true as const, data: { servers: [] } })),
    mcpRefresh: vi.fn(async () => ({ ok: true as const, data: { servers: [] } })),
    marketplaceBrowse: vi.fn(async () => ({
      ok: true as const,
      data: {
        packages: [
          {
            id: 'filesystem',
            name: 'Filesystem',
            version: '1.0.0',
            description: 'Bundled MCP',
            kind: 'mcp' as const,
            source: 'bundled' as const,
            bundledPath: 'filesystem'
          }
        ]
      }
    })),
    marketplaceListInstalled: vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, items: [] }
    })),
    marketplaceRefreshCatalog: vi.fn(async () => ({
      ok: true as const,
      data: { packages: [], remoteCount: 0 }
    })),
    marketplaceInstall: vi.fn(async () => ({
      ok: false as const,
      error: 'not used'
    })),
    marketplaceUninstall: vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, items: [] }
    })),
    marketplaceSetEnabled: vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, items: [] }
    })),
    marketplacePickLocal: vi.fn(async () => ({ ok: true as const, data: null })),
    marketplaceGetContents: vi.fn(async () => ({
      ok: false as const,
      error: 'not found'
    }))
  }
})

describe('settings', () => {
  it('surfaces secure-storage unavailable messaging', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        encryptionAvailable={false}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.getByText(/secure storage is unavailable/i)).toBeTruthy()
    expect(screen.getByPlaceholderText(/Secure storage unavailable/i)).toBeTruthy()
  })

  it('settings has no duplicate model pickers; Providers sets active provider', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={{ ...emptySecrets, openai: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    expect(screen.queryByLabelText(/^Model$/i)).toBeNull()
    expect(screen.queryByPlaceholderText(/Custom model id/i)).toBeNull()
    expect(screen.getByRole('button', { name: /^Providers$/i })).toBeTruthy()
    expect(screen.queryByLabelText(/Max steps/i)).toBeNull()
    expect(screen.queryByLabelText(/Enable extended thinking/i)).toBeNull()
    expect(screen.getAllByText(/^Workspaces$/i).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.getByLabelText(/Active provider/i)).toBeTruthy()
    expect(screen.getByLabelText(/Ollama base URL/i)).toBeTruthy()
    expect(screen.getByLabelText(/API key status/i)).toBeTruthy()
    expect(screen.queryByText(/change provider in the composer/i)).toBeNull()
  })

  it('shows custom model as read-only active model', () => {
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'ollama', model: 'my-custom-model' }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    expect(screen.getAllByText(/my-custom-model/).length).toBeGreaterThan(0)
    expect(screen.queryByPlaceholderText(/Custom model id/i)).toBeNull()
  })

  it('active model badge uses row width not a fixed 200px cap', () => {
    const longModel = 'deepseek/deepseek-v4-flash-0731-extra-long-suffix'
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'custom', model: longModel }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    const badge = screen.getByTitle(longModel)
    expect(badge.className).not.toContain('max-w-[200px]')
    expect(badge.className).toContain('max-w-full')
  })

  it('surfaces save key errors as alert', async () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({
          ok: false as const,
          error: 'secure storage failed'
        }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.change(screen.getByLabelText(/API key \(OpenAI\)/i), {
      target: { value: 'sk-test' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Save key/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/secure storage failed/)
  })

  it('saving a non-active provider key activates it and refreshes models', async () => {
    const onSaveSecret = vi.fn(async () => ({ ok: true as const }))
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={onSaveSecret}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/i }))
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic' })
      )
    )
    fireEvent.change(screen.getByLabelText(/API key \(Anthropic\)/i), {
      target: { value: 'sk-ant' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Save key/i }))
    await waitFor(() => expect(onSaveSecret).toHaveBeenCalledWith('anthropic', 'sk-ant'))
    await waitFor(() =>
      expect(window.vyotiq.listModels).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic', forceRefresh: true })
      )
    )
    expect(screen.queryByText(/Switch provider in the composer/i)).toBeNull()
  })

  it('switches active provider to OpenRouter from Providers when DeepSeek lacks a key', async () => {
    function Harness() {
      const [settings, setSettings] = useState<Settings>({
        ...baseSettings,
        provider: 'deepseek',
        model: 'deepseek-v4-flash'
      })
      return (
        <SettingsView
          settings={settings}
          secrets={{ ...emptySecrets, openrouter: true }}
          onClose={vi.fn()}
          onUpdate={async (partial) => {
            setSettings((prev) => ({ ...prev, ...partial }))
            return { ok: true as const }
          }}
          onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
          onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        />
      )
    }

    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.getByText(/Active provider is DeepSeek/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Use OpenRouter/i }))
    await waitFor(() =>
      expect(screen.getByLabelText(/Active provider/i).textContent).toMatch(/OpenRouter/i)
    )
    fireEvent.click(screen.getByRole('button', { name: /Refresh models/i }))
    await waitFor(() =>
      expect(window.vyotiq.listModels).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openrouter', forceRefresh: true })
      )
    )
  })

  it('refreshes models after saving active provider key', async () => {
    const onSaveSecret = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={onSaveSecret}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.change(screen.getByLabelText(/API key \(OpenAI\)/i), {
      target: { value: 'sk-live' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Save key/i }))
    await waitFor(() => expect(onSaveSecret).toHaveBeenCalledWith('openai', 'sk-live'))
    await waitFor(() =>
      expect(window.vyotiq.listModels).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', forceRefresh: true })
      )
    )
  })

  it('validates ollama url', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    const ollama = screen.getByLabelText(/Ollama base URL/i)
    fireEvent.change(ollama, { target: { value: 'not-a-url' } })
    fireEvent.blur(ollama)
    expect((await screen.findByRole('alert')).textContent).toMatch(/http\(s\) URL/)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('surfaces refresh model errors', async () => {
    // @ts-expect-error test bridge
    window.vyotiq.listModels = vi.fn(async () => ({
      ok: false as const,
      error: 'catalog unavailable'
    }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={{ ...emptySecrets, openai: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.click(screen.getByRole('button', { name: /Refresh models/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/catalog unavailable/)
  })

  it('surfaces seed fallback warning as alert, not as live catalog success', async () => {
    // @ts-expect-error test bridge
    window.vyotiq.listModels = vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [
          {
            id: 'qwen2.5',
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsTools: true,
            supportsVision: false
          }
        ],
        warning: 'Cannot reach Ollama at http://127.0.0.1:11434 (fetch failed: ECONNREFUSED). Showing seed defaults (not live models).'
      }
    }))
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'ollama', model: 'qwen2.5' }}
        secrets={{ ...emptySecrets, openrouter: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.getByText(/1\/10 saved/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Refresh models/i }))
    expect(
      await screen.findByText(/seed models for Ollama.*Cannot reach Ollama/i)
    ).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/^1 models for Ollama · fetch failed$/)).toBeNull()
  })

  it('blocks cloud refresh without a saved key before calling listModels', async () => {
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'deepseek', model: 'deepseek-v4-flash' }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.click(screen.getByRole('button', { name: /Refresh models/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/DeepSeek API key not set/i)
    expect(window.vyotiq.listModels).not.toHaveBeenCalled()
  })

  it('Refresh models uses workspace override custom URL when active', async () => {
    const workspacePath = 'C:\\ws\\proj'
    render(
      <SettingsView
        settings={{
          ...baseSettings,
          provider: 'custom',
          model: 'local',
          customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1'
        }}
        secrets={{ ...emptySecrets, custom: true }}
        activeWorkspacePath={workspacePath}
        settingsOverridesByPath={{
          [workspacePath]: {
            useOverride: true,
            customOpenAiBaseUrl: 'http://192.168.1.50:9000/v1'
          }
        }}
        effectiveChatSettings={{
          provider: 'custom',
          model: 'local',
          ollamaBaseUrl: DEFAULT_SETTINGS.ollamaBaseUrl,
          customOpenAiBaseUrl: 'http://192.168.1.50:9000/v1',
          compactionTriggerRatio: DEFAULT_SETTINGS.compactionTriggerRatio,
          keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
          thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
          thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
          showThinking: DEFAULT_SETTINGS.showThinking,
          toolApproval: DEFAULT_SETTINGS.toolApproval
        }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.click(screen.getByRole('button', { name: /Refresh models/i }))
    await waitFor(() =>
      expect(window.vyotiq.listModels).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'custom',
          baseUrl: 'http://192.168.1.50:9000/v1',
          forceRefresh: true
        })
      )
    )
  })

  it('theme menu calls onSetTheme', () => {
    const onSetTheme = vi.fn()
    render(
      <SettingsView
        settings={baseSettings}
        secrets={{ ...emptySecrets, openai: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        onSetTheme={onSetTheme}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Theme$/i }))
    const listbox = screen.getByRole('listbox')
    fireEvent.click(within(listbox).getByText('Dark'))
    expect(onSetTheme).toHaveBeenCalledWith('dark')
  })

  it('edits MCP server fields in Marketplace manage view', async () => {
    const serverId = 'mcp-test-id'
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    const { MarketplaceView } = await import('@renderer/features/marketplace')
    render(
      <MarketplaceView
        settings={{
          ...baseSettings,
          mcpServers: [
            {
              id: serverId,
              name: 'Echo server',
              command: 'node',
              args: ['echo-server.mjs'],
              enabled: true,
              source: 'manual'
            }
          ]
        }}
        onUpdate={onUpdate}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: /^Manage$/i }))
    expect(await screen.findByRole('tab', { name: /^Installed$/i })).toBeTruthy()
    // Manage view refreshes connections on open (mcpRefresh, not mcpStatus).
    await waitFor(() => expect(window.vyotiq.mcpRefresh).toHaveBeenCalled())

    const nameInput = screen.getByLabelText(`MCP server name for ${serverId}`)
    fireEvent.change(nameInput, { target: { value: 'Filesystem' } })
    fireEvent.blur(nameInput)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [
            expect.objectContaining({ id: serverId, name: 'Filesystem' })
          ]
        })
      )
    )

    const commandInput = screen.getByLabelText(`MCP command for ${serverId}`)
    fireEvent.change(commandInput, { target: { value: 'npx' } })
    fireEvent.blur(commandInput)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [expect.objectContaining({ id: serverId, command: 'npx' })]
        })
      )
    )

    const argsInput = screen.getByLabelText(`MCP arguments for ${serverId}`)
    fireEvent.change(argsInput, { target: { value: '-y\n@modelcontextprotocol/server-filesystem\n.' } })
    fireEvent.blur(argsInput)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [
            expect.objectContaining({
              id: serverId,
              args: ['-y', '@modelcontextprotocol/server-filesystem', '.']
            })
          ]
        })
      )
    )

    const envInput = screen.getByLabelText(`MCP environment for ${serverId}`)
    fireEvent.change(envInput, { target: { value: 'FOO=bar\nBAZ=qux' } })
    fireEvent.blur(envInput)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [
            expect.objectContaining({
              id: serverId,
              env: { FOO: 'bar', BAZ: 'qux' }
            })
          ]
        })
      )
    )
  })

  it('shows MCP connection status in Marketplace manage view', async () => {
    const statusPayload = {
      ok: true as const,
      data: {
        servers: [
          {
            id: 'srv-1',
            name: 'Echo',
            enabled: true,
            connected: true,
            toolCount: 2
          }
        ]
      }
    }
    // @ts-expect-error test bridge
    window.vyotiq.mcpStatus = vi.fn(async () => statusPayload)
    // Manage view loads status via mcpRefresh on open.
    // @ts-expect-error test bridge
    window.vyotiq.mcpRefresh = vi.fn(async () => statusPayload)

    const { MarketplaceView } = await import('@renderer/features/marketplace')
    render(
      <MarketplaceView
        settings={{
          ...baseSettings,
          mcpServers: [
            {
              id: 'srv-1',
              name: 'Echo',
              transport: 'stdio',
              command: 'node',
              args: ['echo.mjs'],
              enabled: true,
              source: 'manual'
            }
          ]
        }}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: /^Manage$/i }))
    expect(await screen.findByRole('tab', { name: /^Installed$/i })).toBeTruthy()
    expect(await screen.findByText(/Connected · 2 tools/i)).toBeTruthy()
  })

  it('opens Marketplace settings section for marketplace registry URL', async () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Marketplace$/i }))
    expect(await screen.findByLabelText(/Registry URL/i)).toBeTruthy()
    expect(screen.getByLabelText(/Acknowledge marketplace install risk/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Browse$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Installed$/i })).toBeNull()
  })
})
