/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MarketplaceView } from '@renderer/features/marketplace'
import type { Settings } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

const baseSettings: Settings = {
  ...DEFAULT_SETTINGS,
  marketplace: { registryUrl: '', remoteInstallAcked: true },
  mcpServers: []
}

const catalogPackages = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    version: '1.0.0',
    description: 'MCP filesystem',
    kind: 'mcp' as const,
    source: 'bundled' as const,
    sections: ['featured'] as const,
    category: 'infrastructure',
    featuredRank: 1,
    verified: true,
    publisher: 'Model Context Protocol',
    installable: true,
    bundledPath: 'filesystem'
  },
  {
    id: 'memory',
    name: 'Memory',
    version: '1.0.0',
    description: 'MCP memory',
    kind: 'mcp' as const,
    source: 'bundled' as const,
    sections: ['featured'] as const,
    category: 'infrastructure',
    featuredRank: 2,
    verified: true,
    publisher: 'Model Context Protocol',
    installable: true,
    bundledPath: 'memory'
  },
  {
    id: 'docs',
    name: 'Docs',
    version: '1.0.0',
    description: 'Docs skill',
    kind: 'skill' as const,
    source: 'bundled' as const,
    category: 'skills',
    verified: true,
    publisher: 'Vyotiq',
    installable: true,
    bundledPath: 'docs'
  },
  {
    id: 'fetch',
    name: 'Fetch',
    version: '1.0.0',
    description: 'Fetch MCP',
    kind: 'mcp' as const,
    source: 'bundled' as const,
    category: 'infrastructure',
    verified: true,
    publisher: 'Model Context Protocol',
    installable: true,
    bundledPath: 'fetch'
  },
  {
    id: 'devtools',
    name: 'Devtools',
    version: '1.0.0',
    description: 'Plugin',
    kind: 'plugin' as const,
    source: 'bundled' as const,
    category: 'plugins',
    verified: true,
    publisher: 'Vyotiq',
    installable: true,
    bundledPath: 'devtools'
  }
]

describe('MarketplaceView', () => {
  beforeEach(() => {
    // @ts-expect-error test bridge
    window.vyotiq = {
      marketplaceBrowse: vi.fn(async (opts?: { q?: string; kind?: string }) => {
        const q = opts?.q?.trim().toLowerCase()
        let packages = catalogPackages
        if (opts?.kind) packages = packages.filter((p) => p.kind === opts.kind)
        if (q) {
          packages = packages.filter(
            (p) =>
              p.id.toLowerCase().includes(q) ||
              p.name.toLowerCase().includes(q) ||
              p.description.toLowerCase().includes(q)
          )
        }
        return { ok: true as const, data: { packages } }
      }),
      marketplaceListInstalled: vi.fn(async () => ({
        ok: true as const,
        data: {
          schemaVersion: 1 as const,
          items: [
            {
              id: 'memory',
              kind: 'mcp' as const,
              name: 'Memory',
              version: '1.0.0',
              description: '',
              enabled: true,
              installSource: 'bundled' as const,
              installedAt: new Date().toISOString(),
              packagePath: 'memory/1.0.0'
            }
          ]
        }
      })),
      marketplaceGetContents: vi.fn(async () => ({
        ok: true as const,
        data: {
          id: 'filesystem',
          kind: 'mcp' as const,
          mcp: [{ id: 'filesystem', name: 'Filesystem', path: 'vyotiq.mcp.json' }],
          skills: [],
          rules: []
        }
      })),
      marketplaceInstall: vi.fn(async () => ({
        ok: true as const,
        data: {
          item: {
            id: 'filesystem',
            kind: 'mcp' as const,
            name: 'Filesystem',
            version: '1.0.0',
            description: '',
            enabled: true,
            installSource: 'bundled' as const,
            installedAt: new Date().toISOString(),
            packagePath: 'filesystem/1.0.0'
          }
        }
      })),
      mcpStatus: vi.fn(async () => ({
        ok: true as const,
        data: {
          servers: [
            {
              id: 'memory',
              name: 'Memory',
              enabled: true,
              connected: true,
              toolCount: 2
            }
          ]
        }
      })),
      mcpRefresh: vi.fn(async () => ({
        ok: true as const,
        data: {
          servers: [
            {
              id: 'memory',
              name: 'Memory',
              enabled: true,
              connected: true,
              toolCount: 2
            }
          ]
        }
      })),
      marketplaceDetectMcp: vi.fn(async () => ({
        ok: true as const,
        data: {
          kind: 'stdio' as const,
          confidence: 'high' as const,
          server: {
            id: 'mcp-fetch',
            name: 'fetch',
            transport: 'stdio' as const,
            command: 'uvx',
            args: ['mcp-server-fetch'],
            enabled: true,
            source: 'manual' as const
          },
          warnings: [],
          duplicate: false
        }
      })),
      marketplaceApplyDetectedMcp: vi.fn(async () => ({
        ok: true as const,
        data: { applied: 'manual' as const, serverId: 'mcp-fetch' }
      })),
      marketplaceScanExternalMcp: vi.fn(async () => ({
        ok: true as const,
        data: {
          preview: [],
          applied: 0,
          skipped: 0,
          warnings: [],
          scannedPaths: []
        }
      })),
      marketplaceImportExternalMcp: vi.fn(async () => ({
        ok: true as const,
        data: {
          preview: [],
          applied: 0,
          skipped: 0,
          warnings: [],
          scannedPaths: []
        }
      })),
      marketplacePickLocal: vi.fn(async () => ({ ok: true as const, data: null }))
    }
  })

  it('renders Featured without Discover and lists each package once', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    expect(await screen.findByRole('heading', { name: /^Installed$/i })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: /^Featured$/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^Discover$/i })).toBeNull()
    expect(screen.getAllByText('Filesystem').length).toBe(1)
    expect(screen.getAllByText('Memory').length).toBe(1)
    expect(screen.getAllByText('Docs').length).toBe(1)
    expect(screen.getByRole('heading', { name: /^Skills$/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /^Infrastructure$/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /^Plugins$/i })).toBeTruthy()
    expect(screen.getByText('Fetch')).toBeTruthy()
    expect(screen.getByText('Devtools')).toBeTruthy()
    // Installed packages sit in Installed, not Featured / categories
    const installedSection = screen.getByRole('heading', { name: /^Installed$/i }).closest('section')
    expect(installedSection?.textContent).toContain('Memory')
    const featured = screen.getByRole('heading', { name: /^Featured$/i }).closest('section')
    expect(featured?.textContent).toContain('Filesystem')
    expect(featured?.textContent).not.toContain('Memory')
    const infra = screen.getByRole('heading', { name: /^Infrastructure$/i }).closest('section')
    expect(infra?.textContent).toContain('Fetch')
    expect(infra?.textContent).not.toContain('Filesystem')
    expect(infra?.textContent).not.toContain('Memory')
    expect(screen.queryByRole('button', { name: /^Coming soon$/i })).toBeNull()
  })

  it('Manage Installed lists installed packages and Add tab is reachable', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    expect(await screen.findByRole('tab', { name: /^Installed$/i })).toBeTruthy()
    expect(await screen.findByText('Memory')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Add$/i }))
    expect(await screen.findByLabelText(/Paste MCP URL, command, or JSON/i)).toBeTruthy()
  })

  it('shows connected state for installed MCP packages', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    expect(await screen.findAllByText(/Connected · 2 tools/i)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Connected$/i }).length).toBeGreaterThan(0)
  })

  it('marks the selected package when returning from detail', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.click(screen.getByText('Filesystem'))
    expect(await screen.findByRole('button', { name: /^Add to Vyotiq$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Marketplace$/i }))
    await screen.findByRole('heading', { name: /^Featured$/i })
    const selected = screen.getAllByRole('button', { current: true })
    expect(selected.some((el) => el.textContent?.includes('Filesystem'))).toBe(true)
  })

  it('opens package detail with contents', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.click(screen.getByText('Filesystem'))
    expect(await screen.findByRole('button', { name: /^Add to Vyotiq$/i })).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^MCP$/i })).toBeTruthy()
    })
  })

  it('opens Manage from header Browse/Manage tabs', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    const manageTabs = await screen.findAllByRole('tab', { name: /^Manage$/i })
    fireEvent.click(manageTabs[0]!)
    expect(await screen.findByRole('tab', { name: /^Installed$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Browse$/i }))
    expect(await screen.findByRole('heading', { name: /^Featured$/i })).toBeTruthy()
  })

  it('exposes full package names on truncated cards and roving tab a11y', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })

    const filesystem = screen.getByRole('button', { name: 'Filesystem' })
    expect(filesystem.getAttribute('title')).toBe('Filesystem')
    expect(filesystem.querySelector('p[title="Filesystem"]')).toBeTruthy()
    expect(filesystem.querySelector('p[title="MCP filesystem"]')).toBeTruthy()

    const browse = screen.getByRole('tab', { name: /^Browse$/i })
    const manage = screen.getAllByRole('tab', { name: /^Manage$/i })[0]!
    expect(browse.getAttribute('aria-selected')).toBe('true')
    expect(browse.getAttribute('tabindex')).toBe('0')
    expect(manage.getAttribute('tabindex')).toBe('-1')
    expect(browse.getAttribute('aria-controls')).toBe('marketplace-browse-panel')
    expect(document.getElementById('marketplace-browse-panel')?.getAttribute('role')).toBe(
      'tabpanel'
    )

    fireEvent.keyDown(browse.closest('[role="tablist"]')!, { key: 'ArrowRight' })
    expect(await screen.findByRole('tab', { name: /^Installed$/i })).toBeTruthy()
    const manageHeader = screen.getAllByRole('tab', { name: /^Manage$/i })[0]!
    expect(manageHeader.getAttribute('aria-selected')).toBe('true')
    expect(manageHeader.getAttribute('tabindex')).toBe('0')
  })

  it('empty search points to Manage → Add for external MCPs', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.change(screen.getByLabelText(/Search marketplace/i), {
      target: { value: 'not-in-catalog-xyz' }
    })
    expect(
      await screen.findByText(/No matching packages in the curated catalog/i)
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Open Manage to add$/i }))
    expect(await screen.findByRole('tab', { name: /^Installed$/i })).toBeTruthy()
  })

  it('links installed detail to Manage', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    await screen.findByRole('heading', { name: /^Featured$/i })
    fireEvent.click(screen.getByText('Memory'))
    expect(await screen.findByRole('button', { name: /^Connected$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Manage$/i }))
    expect(await screen.findByRole('tab', { name: /^Installed$/i })).toBeTruthy()
  })

  it('detects pasted stdio MCP on Manage Add tab', async () => {
    render(
      <MarketplaceView settings={baseSettings} onUpdate={vi.fn(async () => ({ ok: true as const }))} />
    )
    fireEvent.click((await screen.findAllByRole('tab', { name: /^Manage$/i }))[0]!)
    fireEvent.click(await screen.findByRole('tab', { name: /^Add$/i }))
    const paste = await screen.findByLabelText(/Paste MCP URL, command, or JSON/i)
    fireEvent.change(paste, { target: { value: 'uvx mcp-server-fetch' } })
    fireEvent.click(screen.getByRole('button', { name: /^Detect$/i }))
    expect(await screen.findByDisplayValue('uvx')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Add & connect/i }))
    await waitFor(() => {
      expect(window.vyotiq.marketplaceApplyDetectedMcp).toHaveBeenCalled()
    })
  })
})
