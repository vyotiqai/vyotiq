import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'

/**
 * Like `@electron-toolkit/utils` `optimizer.watchWindowShortcuts`, but does not
 * swallow Ctrl/Cmd+R in production. Packaged Chromium still must not reload the
 * window — we preventDefault and re-dispatch a page KeyboardEvent so Changes/PR
 * refresh handlers can run.
 */
export function watchWindowShortcuts(window: BrowserWindow): void {
  if (!window) return
  const { webContents } = window

  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    if (!is.dev) {
      if (input.code === 'KeyR' && (input.control || input.meta)) {
        event.preventDefault()
        const payload = JSON.stringify({
          key: 'r',
          code: 'KeyR',
          ctrlKey: Boolean(input.control),
          metaKey: Boolean(input.meta),
          shiftKey: Boolean(input.shift),
          altKey: Boolean(input.alt),
          bubbles: true,
          cancelable: true
        })
        void webContents
          .executeJavaScript(
            `window.dispatchEvent(new KeyboardEvent('keydown', ${payload}))`
          )
          .catch(() => {
            /* window may be gone */
          })
        return
      }
      // Ignore DevTools open chords in production
      if (
        input.code === 'KeyI' &&
        ((input.alt && input.meta) || (input.control && input.shift))
      ) {
        event.preventDefault()
      }
    } else if (input.code === 'F12') {
      if (webContents.isDevToolsOpened()) {
        webContents.closeDevTools()
      } else {
        webContents.openDevTools({ mode: 'undocked' })
      }
    }

    // Match toolkit default: disable zoom shortcuts
    if (input.code === 'Minus' && (input.control || input.meta)) {
      event.preventDefault()
    }
    if (input.code === 'Equal' && input.shift && (input.control || input.meta)) {
      event.preventDefault()
    }
  })
}
