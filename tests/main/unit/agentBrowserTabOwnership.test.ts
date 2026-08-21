import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sessionOn = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      on: sessionOn
    })
  },
  WebContentsView: class {
    webContents = {
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => false,
      close: vi.fn(),
      focus: vi.fn(),
      getTitle: () => '',
      getURL: () => '',
      isLoading: () => false,
      loadURL: vi.fn().mockResolvedValue(undefined),
      setBackgroundThrottling: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn() },
      capturePage: vi.fn().mockResolvedValue({
        getSize: () => ({ width: 10, height: 10 }),
        toJPEG: () => Buffer.from([0xff, 0xd8])
      })
    }
    setBounds = vi.fn()
    setVisible = vi.fn()
  }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({ browserDomainAllowlist: [] }))
}))

import {
  manageTabs,
  navigateUrl,
  resetAgentBrowserForTests,
  selectBrowserTab,
  takeBrowserScreenshot
} from '@main/app/agentBrowser'

const WS_A = '/ws-a'
const WS_B = '/ws-b'

function tabIdFromOpen(result: string): string {
  const match = result.match(/Opened tab (t\d+)/)
  if (!match) throw new Error(`unexpected open result: ${result}`)
  return match[1]
}

describe('browser tab workspace ownership', () => {
  let runDir = ''

  beforeEach(() => {
    sessionOn.mockClear()
    runDir = mkdtempSync(join(tmpdir(), 'vyotiq-browser-ss-'))
  })

  afterEach(() => {
    resetAgentBrowserForTests()
    rmSync(runDir, { recursive: true, force: true })
  })

  async function openOwnedTabs(): Promise<{ tabA: string; tabB: string }> {
    const tabA = tabIdFromOpen(await manageTabs('open', { workspacePath: WS_A }))
    const tabB = tabIdFromOpen(await manageTabs('open', { workspacePath: WS_B }))
    return { tabA, tabB }
  }

  it('refuses navigate to an explicit tab owned by another workspace', async () => {
    const { tabA } = await openOwnedTabs()
    await expect(
      navigateUrl('https://example.com', {
        tabId: tabA,
        workspacePath: WS_B,
        agentControl: false
      })
    ).rejects.toThrow(`Unknown browser tab_id: ${tabA}`)
  })

  it('refuses select/close of an explicit tab owned by another workspace', async () => {
    const { tabA, tabB } = await openOwnedTabs()

    await expect(manageTabs('select', { tabId: tabA, workspacePath: WS_B })).rejects.toThrow(
      `Unknown browser tab_id: ${tabA}`
    )
    expect(selectBrowserTab(tabA, WS_B)).toBe(false)
    expect(selectBrowserTab(tabA, WS_A)).toBe(true)

    await expect(manageTabs('close', { tabId: tabA, workspacePath: WS_B })).rejects.toThrow(
      `Unknown browser tab_id: ${tabA}`
    )
    await expect(manageTabs('close', { tabId: tabA, workspacePath: WS_A })).resolves.toBe(
      `Closed tab ${tabA}`
    )
    expect(tabB).toMatch(/^t\d+$/)
  })

  it('refuses screenshot of an explicit tab owned by another workspace', async () => {
    const { tabA } = await openOwnedTabs()

    await expect(
      takeBrowserScreenshot({
        runDir,
        tabId: tabA,
        workspacePath: WS_B
      })
    ).rejects.toThrow(`Unknown browser tab_id: ${tabA}`)

    const result = await takeBrowserScreenshot({
      runDir,
      tabId: tabA,
      workspacePath: WS_A
    })
    expect(result.path).toContain(join('browser', 'snapshot-'))
  })

  it('installs a will-download handler that prevents unowned downloads', async () => {
    await openOwnedTabs()
    expect(sessionOn).toHaveBeenCalledWith('will-download', expect.any(Function))
    const handler = sessionOn.mock.calls.find((call) => call[0] === 'will-download')?.[1] as
      | ((event: { preventDefault: () => void }) => void)
      | undefined
    expect(handler).toBeTypeOf('function')
    const event = { preventDefault: vi.fn() }
    handler!(event)
    expect(event.preventDefault).toHaveBeenCalled()
  })
})
