/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { logger, setLoggerBackend, getLoggerBackend } from '@shared/logger'
import {
  installRendererErrorHandlers,
  isRendererErrorHandlersInstalled
} from '@renderer/logging/handlers'

describe('renderer error handlers', () => {
  const previous = getLoggerBackend()
  const fatal = vi.fn()

  beforeEach(() => {
    fatal.mockReset()
    setLoggerBackend({
      log: (level, message, fields) => {
        if (level === 'fatal') fatal(message, fields)
      }
    })
  })

  afterEach(() => {
    setLoggerBackend(previous)
  })

  it('installs window error and unhandledrejection listeners once', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    installRendererErrorHandlers()
    expect(isRendererErrorHandlersInstalled()).toBe(true)
    installRendererErrorHandlers()
    const errorCalls = addSpy.mock.calls.filter(([type]) => type === 'error')
    const rejectionCalls = addSpy.mock.calls.filter(([type]) => type === 'unhandledrejection')
    expect(errorCalls.length).toBe(1)
    expect(rejectionCalls.length).toBe(1)
    addSpy.mockRestore()
  })

  it('logs uncaught errors via logger.fatal', () => {
    installRendererErrorHandlers()
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'boom',
        filename: 'app.js',
        lineno: 1,
        colno: 1,
        error: new Error('boom')
      })
    )
    expect(fatal).toHaveBeenCalledWith(
      expect.stringMatching(/^Uncaught renderer error:/),
      expect.objectContaining({ scope: 'renderer', code: 'UNCAUGHT' })
    )
  })

  it('logs unhandled rejections via logger.fatal', async () => {
    installRendererErrorHandlers()
    const event = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(event, 'reason', { value: new Error('reject') })
    window.dispatchEvent(event)
    expect(fatal).toHaveBeenCalledWith(
      expect.stringMatching(/^Unhandled renderer rejection:/),
      expect.objectContaining({ scope: 'renderer', code: 'UNCAUGHT' })
    )
  })
})
