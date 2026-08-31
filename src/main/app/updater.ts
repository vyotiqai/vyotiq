import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '../../shared/channels'
import type { UpdaterStatus } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { getSettings } from '../settings/settings'

let current: UpdaterStatus = { state: 'idle' }
let initialized = false

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

function broadcast(status: UpdaterStatus): void {
  current = status
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(IPC.updaterStatusEvent, status)
    } catch {
      /* ignore */
    }
  }
}

export function updaterStatus(): UpdaterStatus {
  return current
}

export function initAutoUpdater(): void {
  if (initialized) return
  initialized = true
  // Updates download as soon as a newer release is found and install on quit
  // (autoInstallOnAppQuit). Manual check/download/install IPC stays available.
  autoUpdater.autoDownload = true
  // This app ships full NSIS installers only; reject web-installer payloads.
  autoUpdater.disableWebInstaller = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (m) => logger.info(`[updater] ${m}`),
    warn: (m) => logger.warn(`[updater] ${m}`),
    error: (m) => logger.error(`[updater] ${m}`),
    debug: (m) => logger.debug(`[updater] ${m}`)
  } as typeof autoUpdater.logger

  autoUpdater.on('checking-for-update', () => {
    broadcast({ state: 'checking', message: 'Checking GitHub Releases…' })
  })
  autoUpdater.on('update-available', (info) => {
    broadcast({
      state: 'available',
      version: info.version,
      message: `Version ${info.version} is available.`
    })
  })
  autoUpdater.on('update-not-available', () => {
    broadcast({
      state: 'none',
      version: app.getVersion(),
      message: `Vyotiq ${app.getVersion()} is current.`
    })
  })
  autoUpdater.on('download-progress', (progress) => {
    const fraction = Math.max(0, Math.min(1, progress.percent / 100))
    broadcast({
      state: 'downloading',
      progress: fraction,
      message: `Downloading ${Math.round(progress.percent)}%`
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    broadcast({
      state: 'ready',
      version: info.version,
      message: `Version ${info.version} is ready to install.`
    })
  })
  autoUpdater.on('error', (err) => {
    broadcast({
      state: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  })

  if (!app.isPackaged) {
    current = {
      state: 'dev',
      message: 'Auto-update runs in packaged builds. Pack and publish a GitHub Release to ship updates.'
    }
    return
  }

  if (getSettings().autoCheckUpdates) {
    void checkForAppUpdates().catch((err) => {
      logger.warn('[updater] startup check failed', err)
    })
  }

  // Long-running sessions must pick up new releases too: re-check every 6h
  // unless an update is already downloading or waiting to be installed.
  setInterval(() => {
    if (!getSettings().autoCheckUpdates) return
    if (current.state === 'downloading' || current.state === 'ready') return
    void checkForAppUpdates().catch((err) => {
      logger.warn('[updater] periodic check failed', err)
    })
  }, UPDATE_CHECK_INTERVAL_MS)
}

export async function checkForAppUpdates(): Promise<UpdaterStatus> {
  if (!app.isPackaged) {
    const status: UpdaterStatus = {
      state: 'dev',
      message: 'Auto-update runs in packaged builds. Pack and publish a GitHub Release to ship updates.'
    }
    broadcast(status)
    return status
  }
  try {
    await autoUpdater.checkForUpdates()
    return current
  } catch (err) {
    const status: UpdaterStatus = {
      state: 'error',
      message: err instanceof Error ? err.message : String(err)
    }
    broadcast(status)
    return status
  }
}

export async function downloadAppUpdate(): Promise<UpdaterStatus> {
  if (!app.isPackaged) return checkForAppUpdates()
  if (current.state !== 'available' && current.state !== 'downloading') {
    const status: UpdaterStatus = {
      state: 'error',
      message: 'No update is available to download. Check for updates first.'
    }
    broadcast(status)
    return status
  }
  try {
    await autoUpdater.downloadUpdate()
    return current
  } catch (err) {
    const status: UpdaterStatus = {
      state: 'error',
      message: err instanceof Error ? err.message : String(err)
    }
    broadcast(status)
    return status
  }
}

export function installAppUpdate(): UpdaterStatus {
  if (!app.isPackaged) {
    const status: UpdaterStatus = {
      state: 'dev',
      message: 'Auto-update runs in packaged builds. Pack and publish a GitHub Release to ship updates.'
    }
    broadcast(status)
    return status
  }
  if (current.state !== 'ready') {
    const status: UpdaterStatus = {
      state: 'error',
      message: 'Download the update before restarting to install.'
    }
    broadcast(status)
    return status
  }
  autoUpdater.quitAndInstall()
  return current
}
