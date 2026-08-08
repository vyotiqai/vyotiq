import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp } from '@electron-toolkit/utils'
import { watchWindowShortcuts } from '@main/app/windowShortcuts'
import { createWindow, applyTitleBarTheme, getMainWindow } from '@main/app/window'
import { configureChromiumDiskCache } from '@main/app/chromiumProfile'
import { applyCertificateLogging, applyCsp } from '@main/app/security'
import { closeAgentBrowser } from '@main/app/agentBrowser'
import { disposeAllPtySessions, replayPtySessionsToWindow } from '@main/app/ptySessions'
import { disposeAllTerminalSessions } from '@main/agent/tools/terminalSessions'
import { registerIpc } from './ipc/register'
import { shutdownMcpServers, syncMcpServers } from '@main/agent/mcp'
import { resolveEffectiveMcpServers, syncMarketplaceMcpIntoSettings, purgeOrphanMarketplacePackageDirs } from '@main/marketplace'
import { getSettings } from '@main/settings/settings'
import { migrateLegacySessions } from '@main/storage/migrations/migrateSessions'
import { migrateWorkspaceRuns } from './storage/migrateWorkspaceRuns'
import { purgeLegacyProjectHarness } from '@main/agent/harness'
import { compactModelCacheOnBoot } from '@main/agent/providers/modelCache'
import {
  flushEventAppends,
  flushMessageAppends,
  flushStatusWrites
} from '@main/agent/state'
import { shutdownTokenizerPool } from '@main/agent/context/tokenizerPool'
import {
  getWorkspaces,
  interruptOrphanRunsForWorkspaces
} from '@main/workspace/workspaces'
import { initMainLogging } from './logging/init'
import { initCrashReporter } from './logging/crashReporter'
import { logger } from '../shared/logger'
import { IPC } from '../shared/channels'
import { startLoadPerfMonitor } from './perf/loadSnapshot'

// Keep Chromium caches under userData so concurrent/dev instances do not
// fight over the default Windows profile cache (Access denied / Gpu Cache).
// Fingerprint the main bundle so rebuilds do not reuse stale disk cache.
try {
  configureChromiumDiskCache(join(__dirname, 'index.js'))
} catch {
  // getPath can fail in odd launch contexts; ignore
}

// Crashpad must start before any renderer is created; prefer before ready.
initCrashReporter()

// Windows: GPU sandbox re-enabled — Chromium uses default GPU path on Win 11 26200+.
// If startup crashes return, bisect flags here (do not leave permanent disable-gpu-sandbox).

const QUIT_FLUSH_MS = 5000

let quitting = false
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    // After userData path switches; before IPC / windows (Sentry + electron-log).
    initMainLogging()

    electronApp.setAppUserModelId('com.vyotiq.agent')
    applyCsp()
    applyCertificateLogging()
    try {
      const migration = migrateLegacySessions()
      if (migration.migrated > 0) {
        logger.info(`Migrated ${migration.migrated} legacy session(s)`, { scope: 'main' })
      }
      const runsMigration = migrateWorkspaceRuns()
      if (runsMigration.migrated > 0) {
        logger.info(`Migrated ${runsMigration.migrated} workspace run(s) to AppData`, {
          scope: 'main'
        })
      }
      const workspaces = getWorkspaces()
      const seen = new Set<string>()
      for (const root of [...workspaces.openPaths, ...workspaces.recentPaths]) {
        if (!root) continue
        const key = process.platform === 'win32' ? root.toLowerCase() : root
        if (seen.has(key)) continue
        seen.add(key)
        purgeLegacyProjectHarness(root)
      }
      const n = await interruptOrphanRunsForWorkspaces(workspaces)
      if (n > 0) {
        logger.info(`Interrupted ${n} orphan run(s)`, { scope: 'main' })
      }
      compactModelCacheOnBoot()
    } catch (err) {
      logger.warn('Failed startup workspace maintenance', { scope: 'main', err })
    }
    registerIpc()
    startLoadPerfMonitor()
    try {
      const orphan = purgeOrphanMarketplacePackageDirs()
      if (orphan.removed > 0) {
        logger.info('Purged orphan marketplace package directories', {
          scope: 'main',
          removed: orphan.removed
        })
      }
      await syncMarketplaceMcpIntoSettings()
      void syncMcpServers(resolveEffectiveMcpServers()).catch((err) => {
        logger.warn('MCP sync on startup failed', { scope: 'main', err })
      })
    } catch (err) {
      logger.warn('Marketplace MCP settings sync failed', { scope: 'main', err })
    }

    app.on('browser-window-created', (_, window) => {
      watchWindowShortcuts(window)
    })

    createWindow()
    applyTitleBarTheme(getSettings().theme)

    const pushNativeTheme = (): void => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.themeChanged, nativeTheme.shouldUseDarkColors)
      }
      applyTitleBarTheme(getSettings().theme)
    }
    nativeTheme.on('updated', pushNativeTheme)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const win = createWindow()
        applyTitleBarTheme(getSettings().theme)
        win.webContents.once('did-finish-load', () => {
          replayPtySessionsToWindow(win)
        })
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true

    closeAgentBrowser()
    disposeAllTerminalSessions()
    disposeAllPtySessions()
    void shutdownMcpServers()
    shutdownTokenizerPool()

    void (async () => {
      try {
        let flushTimedOut = false
        await Promise.race([
          Promise.all([flushMessageAppends(), flushEventAppends(), flushStatusWrites()]),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              flushTimedOut = true
              resolve()
            }, QUIT_FLUSH_MS)
          )
        ])
        if (flushTimedOut) {
          logger.warn('Timed out flushing pending run writes before quit; data may be lost', {
            scope: 'main',
            timeoutMs: QUIT_FLUSH_MS
          })
        }
      } catch (err) {
        logger.warn('Failed to flush pending writes before quit', { scope: 'main', err })
      }
      app.quit()
    })()
  })
}
