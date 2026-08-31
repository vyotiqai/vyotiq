import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import { IPC } from '@shared/channels'
import { app as electronApp, BrowserWindow } from 'electron'
import { getSettings } from '@main/settings/settings'
import { autoUpdater as autoUpdaterModule } from 'electron-updater'

interface AutoUpdaterMock extends EventEmitter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  disableWebInstaller: boolean
  checkForUpdates: Mock
  downloadUpdate: Mock
  quitAndInstall: Mock
}

type UpdaterStatusLike = {
  state: string
  version?: string
  message?: string
  progress?: number
}

// vi.mock factories below are hoisted above these imports, so these bindings
// are the mocks. Their instances survive vi.resetModules() (only non-mocked
// modules are re-evaluated), so beforeEach resets their state explicitly.
const autoUpdater = autoUpdaterModule as unknown as AutoUpdaterMock
const electronAppMock = electronApp as unknown as { isPackaged: boolean }
const getAllWindows = BrowserWindow.getAllWindows as unknown as Mock
const getSettingsMock = getSettings as unknown as Mock

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

vi.mock('electron-updater', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class AutoUpdater extends Emitter {
    autoDownload = false
    autoInstallOnAppQuit = false
    disableWebInstaller = false
    logger: unknown = null
    checkForUpdates = vi.fn(async () => null)
    downloadUpdate = vi.fn(async () => null)
    quitAndInstall = vi.fn()
  }
  return { autoUpdater: new AutoUpdater() }
})

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({ autoCheckUpdates: true }))
}))

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

async function loadUpdater(): Promise<typeof import('@main/app/updater')> {
  return import('@main/app/updater')
}

describe('app updater', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    autoUpdater.removeAllListeners()
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.disableWebInstaller = false
    autoUpdater.checkForUpdates.mockReset()
    autoUpdater.checkForUpdates.mockImplementation(async () => null)
    autoUpdater.downloadUpdate.mockReset()
    autoUpdater.downloadUpdate.mockImplementation(async () => null)
    autoUpdater.quitAndInstall.mockReset()
    getAllWindows.mockReset()
    getAllWindows.mockImplementation(() => [])
    getSettingsMock.mockReset()
    getSettingsMock.mockReturnValue({ autoCheckUpdates: true })
    electronAppMock.isPackaged = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks dev builds and never checks for updates', async () => {
    const updater = await loadUpdater()
    electronAppMock.isPackaged = false

    updater.initAutoUpdater()

    expect(updater.updaterStatus().state).toBe('dev')
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()

    const manual = await updater.checkForAppUpdates()
    expect(manual.state).toBe('dev')
  })

  it('checks at startup when autoCheckUpdates is on', async () => {
    const updater = await loadUpdater()

    updater.initAutoUpdater()

    expect(getSettingsMock).toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('skips the startup check and periodic ticks when autoCheckUpdates is off', async () => {
    const updater = await loadUpdater()
    getSettingsMock.mockReturnValue({ autoCheckUpdates: false })

    updater.initAutoUpdater()
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS)

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('re-checks every 6 hours', async () => {
    const updater = await loadUpdater()

    updater.initAutoUpdater()
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS)
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS)

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('skips periodic re-checks while downloading or ready to install', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    autoUpdater.emit('download-progress', { percent: 40 })
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    autoUpdater.emit('update-downloaded', { version: '1.2.0' })
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('configures automatic download, install on quit, and web-installer rejection', async () => {
    const updater = await loadUpdater()

    updater.initAutoUpdater()

    expect(autoUpdater.autoDownload).toBe(true)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(autoUpdater.disableWebInstaller).toBe(true)
  })

  it('broadcasts status changes to every live window', async () => {
    const updater = await loadUpdater()
    const send = vi.fn()
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } },
      { isDestroyed: () => true, webContents: { send: vi.fn() } }
    ])

    updater.initAutoUpdater()
    autoUpdater.emit('update-available', { version: '1.2.0' })

    const expected: UpdaterStatusLike = {
      state: 'available',
      version: '1.2.0',
      message: 'Version 1.2.0 is available.'
    }
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(IPC.updaterStatusEvent, expected)
    expect(updater.updaterStatus()).toEqual(expected)
  })

  it('downloads only when an update is available', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()

    const refused = await updater.downloadAppUpdate()
    expect(refused.state).toBe('error')
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()

    autoUpdater.emit('update-available', { version: '1.2.0' })
    await updater.downloadAppUpdate()

    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('installs only from the ready state via quitAndInstall', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()

    const refused = updater.installAppUpdate()
    expect(refused.state).toBe('error')
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    autoUpdater.emit('update-downloaded', { version: '1.2.0' })
    const result = updater.installAppUpdate()

    expect(result.state).toBe('ready')
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('reports check failures as an error status', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('network down'))

    const result = await updater.checkForAppUpdates()

    expect(result.state).toBe('error')
    expect(result.message).toContain('network down')
  })
})
