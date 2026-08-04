import { logger } from '@shared/logger'
import { logErrorSummary } from '@shared/logPolicy'
import { captureRendererException } from './sentry'

let installed = false

function isBenignScriptError(message: string): boolean {
  return (
    message.includes('ResizeObserver loop') ||
    message.includes('ResizeObserver loop limit exceeded')
  )
}

/** Global renderer error hooks — catches errors outside React's ErrorBoundary. */
export function installRendererErrorHandlers(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (event) => {
    const rawMessage = event.message || ''
    if (isBenignScriptError(rawMessage)) return
    const err = event.error ?? new Error(rawMessage || 'Unknown error')
    logger.fatal(`Uncaught renderer error: ${logErrorSummary(err, 'UNCAUGHT')}`, {
      scope: 'renderer',
      code: 'UNCAUGHT',
      err
    })
    captureRendererException(err, { scope: 'renderer', code: 'UNCAUGHT' })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const err = reason instanceof Error ? reason : new Error(String(reason))
    logger.fatal(`Unhandled renderer rejection: ${logErrorSummary(err, 'UNCAUGHT')}`, {
      scope: 'renderer',
      code: 'UNCAUGHT',
      err
    })
    captureRendererException(err, { scope: 'renderer', code: 'UNCAUGHT' })
  })
}

export function isRendererErrorHandlersInstalled(): boolean {
  return installed
}
