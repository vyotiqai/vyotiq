import { logger } from '@shared/logger'
import { logErrorSummary } from '@shared/logPolicy'
import { captureRendererException } from './sentry'
import {
  componentStackFromUnknown,
  errorMessageFromUnknown,
  isReactMaxUpdateDepth
} from './reactMaxUpdateDepth'

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
    const componentStack = componentStackFromUnknown(event.error)
    const is185 =
      isReactMaxUpdateDepth(rawMessage) ||
      isReactMaxUpdateDepth(err instanceof Error ? err.message : '')
    logger.fatal(
      is185
        ? `React maximum update depth (#185): ${logErrorSummary(err, 'REACT_185')}`
        : `Uncaught renderer error: ${logErrorSummary(err, 'UNCAUGHT')}`,
      {
        scope: 'renderer',
        code: is185 ? 'REACT_185' : 'UNCAUGHT',
        componentStack: componentStack?.slice(0, 4000),
        err
      }
    )
    captureRendererException(err, { scope: 'renderer', code: is185 ? 'REACT_185' : 'UNCAUGHT' })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const err = reason instanceof Error ? reason : new Error(String(reason))
    const message = errorMessageFromUnknown(reason) || err.message
    const componentStack = componentStackFromUnknown(reason)
    const is185 = isReactMaxUpdateDepth(message)
    logger.fatal(
      is185
        ? `React maximum update depth (#185): ${logErrorSummary(err, 'REACT_185')}`
        : `Unhandled renderer rejection: ${logErrorSummary(err, 'UNCAUGHT')}`,
      {
        scope: 'renderer',
        code: is185 ? 'REACT_185' : 'UNCAUGHT',
        componentStack: componentStack?.slice(0, 4000),
        err
      }
    )
    captureRendererException(err, { scope: 'renderer', code: is185 ? 'REACT_185' : 'UNCAUGHT' })
  })
}

export function isRendererErrorHandlersInstalled(): boolean {
  return installed
}
