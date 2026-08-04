import { BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { attachSecurity } from '@main/app/security'
import type { ThemeId } from '../../shared/ipc'
import { resolveTheme } from '../../shared/theme'
import { IPC } from '../../shared/channels'
import {
  MACOS_TRAFFIC_LIGHT_X,
  MACOS_TRAFFIC_LIGHT_Y
} from '../../shared/windowChrome'
import { attachWebContentsCrashLogging } from '@main/logging/init'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** Windows/Linux have no vibrancy — use an opaque chrome color so UI is visible. */
function windowBackground(resolved: 'light' | 'dark'): string {
  if (process.platform === 'darwin') return '#00000000'
  return resolved === 'dark' ? '#000000' : '#ffffff'
}

export function applyTitleBarTheme(theme: ThemeId): void {
  if (!mainWindow) return
  const prefersDark = nativeTheme.shouldUseDarkColors
  const resolved = resolveTheme(theme, prefersDark)
  mainWindow.setBackgroundColor(windowBackground(resolved))
}

function attachWindowStatePush(win: BrowserWindow): void {
  const push = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send(IPC.windowMaximizedChanged, win.isMaximized())
  }
  win.on('maximize', push)
  win.on('unmaximize', push)
  win.on('enter-full-screen', push)
  win.on('leave-full-screen', push)
}

export function createWindow(): BrowserWindow {
  const prefersDark = nativeTheme.shouldUseDarkColors
  const resolved: 'light' | 'dark' = prefersDark ? 'dark' : 'light'

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    // Custom renderer controls own the top-right on win/linux — no titleBarOverlay.
    ...(process.platform === 'darwin'
      ? {
          trafficLightPosition: { x: MACOS_TRAFFIC_LIGHT_X, y: MACOS_TRAFFIC_LIGHT_Y },
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const
        }
      : {}),
    backgroundColor: windowBackground(resolved),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  attachSecurity(mainWindow)
  attachWindowStatePush(mainWindow)
  attachWebContentsCrashLogging(mainWindow.webContents)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}
