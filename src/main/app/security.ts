import { BrowserWindow, session } from 'electron'
import { shell } from 'electron'
import { logger } from '../../shared/logger'

const ALLOWED_EXTERNAL = [/^https:\/\//i]

export function attachSecurity(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ALLOWED_EXTERNAL.some((re) => re.test(url))) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
}

/**
 * Keep Chromium's default rejection for bad certificates and record failures.
 * Never calls `callback(true)` — there is no bypass path for invalid certs.
 * Logged with the host only (no URL path/query, no workspace data).
 */
export function applyCertificateLogging(): void {
  const ses = session.defaultSession
  ses.setCertificateVerifyProc((request, callback) => {
    if (request.errorCode !== 0) {
      logger.warn('Certificate verification failed', {
        scope: 'security',
        code: 'CERT_VERIFY',
        url: request.hostname
      })
    }
    // -3 defers to Chromium's default verdict (reject on error).
    callback(-3)
  })
}

/**
 * Loosen CSP only while electron-vite serves the renderer over HTTP (HMR).
 * `is.dev` is true for any unpackaged run (including `pnpm start` / preview),
 * which must NOT get unsafe-eval — that triggers Electron's security warning
 * and is unnecessary without Vite HMR.
 */
export function needsViteHmrCsp(env: { electronRendererUrl?: string } = {}): boolean {
  const url = env.electronRendererUrl ?? process.env.ELECTRON_RENDERER_URL
  return Boolean(url)
}

/** Build Content-Security-Policy header value for the renderer session. */
export function buildCspPolicy(env: { electronRendererUrl?: string } = {}): string {
  if (needsViteHmrCsp(env)) {
    // Vite injects inline module scripts for HMR; avoid unsafe-eval — modern
    // Vite ESM HMR does not require it, and Electron warns when it is present.
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:* http://127.0.0.1:* http://localhost:* https:"
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* http://localhost:* https:"
  ].join('; ')
}

function cspPolicy(): string {
  return buildCspPolicy()
}

export function applyCsp(): void {
  const policy = cspPolicy()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}
