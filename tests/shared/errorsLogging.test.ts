import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import {
  AppError,
  formatError,
  createCorrelationId,
  isExpectedError,
  isExpectedToolError,
  toAppError,
  toLogErr
} from '@shared/errors'
import { scrubString, scrubPath, scrubValue } from '@shared/scrub'
import {
  logErrorSummary,
  sanitizeErrorForLog,
  sanitizeLogFields,
  sanitizeLogMessage,
  scrubSentryEvent
} from '@shared/logPolicy'
import { workspaceIdFromPath } from '@shared/workspaceId'
import { logger, setLoggerBackend, getLoggerBackend } from '@shared/logger'

describe('formatError + AppError', () => {
  it('formats nested cause chains', () => {
    const inner = Object.assign(new Error('ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 11434
    })
    const outer = new Error('fetch failed', { cause: inner })
    expect(formatError(outer)).toContain('fetch failed')
  })

  it('scrubs secrets in formatError output', () => {
    expect(formatError(new Error('bad sk-abcdefghijklmnop'))).toContain('[redacted]')
    expect(formatError(new Error('bad sk-abcdefghijklmnop'))).not.toContain('sk-abcdefghijklmnop')
  })

  it('returns AppError message directly', () => {
    const err = new AppError('bad key', { code: 'PROVIDER_AUTH' })
    expect(formatError(err)).toBe('bad key')
    expect(err.code).toBe('PROVIDER_AUTH')
    expect(err.severity).toBe('error')
  })

  it('formats Zod issues as readable paths', () => {
    let caught: unknown
    try {
      z.object({ runId: z.string().min(1) }).parse({ runId: '' })
    } catch (err) {
      caught = err
    }
    const msg = formatError(caught)
    expect(msg).toContain('runId')
    expect(msg.toLowerCase()).toMatch(/string|least|min|required|empty|too small/)
  })

  it('toAppError wraps unknowns', () => {
    const wrapped = toAppError(new Error('boom'), { code: 'AGENT_LOOP', correlationId: 'abc' })
    expect(wrapped).toBeInstanceOf(AppError)
    expect(wrapped.code).toBe('AGENT_LOOP')
    expect(wrapped.correlationId).toBe('abc')
  })


  it('classifies expected tool exploration errors', () => {
    expect(isExpectedToolError('File not found: src/a.ts')).toBe(true)
    expect(isExpectedToolError('Unsupported Unix command on Windows: "ls".')).toBe(true)
    expect(isExpectedToolError('Command timed out after 60000ms')).toBe(false)
  })

  it('treats AbortError, Zod, and validation as expected', () => {
    expect(isExpectedError(new DOMException('Aborted', 'AbortError'))).toBe(true)
    expect(isExpectedError(new AppError('bad', { code: 'IPC_VALIDATION' }))).toBe(true)
    expect(isExpectedError(new AppError('boom', { code: 'AGENT_LOOP' }))).toBe(false)
    try {
      z.string().min(1).parse('')
    } catch (err) {
      expect(isExpectedError(err)).toBe(true)
    }
    expect(
      isExpectedError(new AppError('cancelled', { code: 'AGENT_LOOP', cause: new DOMException('Aborted', 'AbortError') }))
    ).toBe(true)
  })

  it('createCorrelationId returns a short non-empty id', () => {
    const id = createCorrelationId()
    expect(id.length).toBeGreaterThanOrEqual(8)
    expect(id.length).toBeLessThanOrEqual(32)
  })

  it('toLogErr wraps IPC string errors as expected AppError', () => {
    const err = toLogErr('workspace not found')
    expect(err).toBeInstanceOf(AppError)
    expect(isExpectedError(err)).toBe(true)
    expect(err.message).toBe('workspace not found')
  })
})

describe('scrubber', () => {
  it('redacts API keys and bearer tokens', () => {
    expect(scrubString('key sk-abc1234567890xyz in text')).toContain('[redacted]')
    expect(scrubString('Authorization: Bearer secret-token-value')).toContain('[redacted]')
    expect(scrubString('X-Api-Key: super-secret-key-value')).toContain('[redacted]')
  })

  it('redacts named tokens in text and URL query strings', () => {
    const url = scrubString(
      'GET https://api.example.com/v1?access_token=oauth-secret-value&x=1'
    )
    const bare = scrubString('token=plain-secret-value')
    expect(url).toContain('[redacted]')
    expect(url).not.toContain('oauth-secret-value')
    expect(bare).toContain('[redacted]')
    expect(bare).not.toContain('plain-secret-value')
  })

  it('redacts JWTs and PEM blocks', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepad'
    expect(scrubString(`token ${jwt}`)).toContain('[redacted]')
    expect(scrubString(`token ${jwt}`)).not.toContain('eyJhbGci')
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----'
    expect(scrubString(pem)).toBe('[redacted-pem]')
  })

  it('redacts data URLs', () => {
    const out = scrubString('img data:image/png;base64,AAAA and more')
    expect(out).toContain('data:[redacted]')
    expect(out).not.toContain('AAAA')
  })

  it('scrubs absolute paths to basename', () => {
    expect(scrubPath('C:\\Users\\admin\\proj\\file.ts')).toBe('file.ts')
    expect(scrubPath('/home/admin/proj/file.ts')).toBe('file.ts')
  })

  it('redacts sensitive object keys', () => {
    const scrubbed = scrubValue({
      apiKey: 'sk-secret',
      accessToken: 'tok',
      AccessToken: 'tok-legacy',
      SESSION_TOKEN: 'session',
      dsn: 'https://key@o.ingest.sentry.io/1',
      path: '/Users/admin/ws/a.ts',
      ok: true
    }) as Record<string, unknown>
    expect(scrubbed.apiKey).toBe('[redacted]')
    expect(scrubbed.accessToken).toBe('[redacted]')
    expect(scrubbed.AccessToken).toBe('[redacted]')
    expect(scrubbed.SESSION_TOKEN).toBe('[redacted]')
    expect(scrubbed.dsn).toBe('[redacted]')
    expect(scrubbed.path).toBe('a.ts')
    expect(scrubbed.ok).toBe(true)
  })

  it('preserves Error message/name when scrubbing LogFields.err', () => {
    const err = new AppError('failed with sk-abcdefghijklmnop', {
      code: 'PROVIDER_HTTP',
      context: { apiKey: 'secret' }
    })
    const scrubbed = scrubValue({ err, scope: 'ipc' }) as {
      err: Record<string, unknown>
      scope: string
    }
    expect(scrubbed.scope).toBe('ipc')
    expect(scrubbed.err.name).toBe('AppError')
    expect(String(scrubbed.err.message)).toContain('[redacted]')
    expect(String(scrubbed.err.message)).not.toContain('sk-abcdefghijklmnop')
    expect(scrubbed.err.code).toBe('PROVIDER_HTTP')
    expect((scrubbed.err.context as Record<string, unknown>).apiKey).toBe('[redacted]')
  })

  it('does not leave global regex lastIndex sticky across calls', () => {
    const sample = 'sk-abc1234567890xyz'
    expect(scrubString(sample)).toContain('[redacted]')
    expect(scrubString(sample)).toContain('[redacted]')
  })
})

describe('log policy (no user workspace data)', () => {
  it('drops forbidden structured fields', () => {
    const out = sanitizeLogFields({
      scope: 'agent',
      workspacePath: 'C:\\Users\\me\\secret-project',
      summary: 'read src/payroll.ts',
      query: 'password',
      tool: 'read',
      correlationId: 'abc123'
    }) as Record<string, unknown>
    expect(out.workspacePath).toBeUndefined()
    expect(out.summary).toBeUndefined()
    expect(out.query).toBeUndefined()
    expect(out.tool).toBe('read')
    expect(out.correlationId).toBe('abc123')
  })

  it('keeps scrubbed providerMessage for HTTP diagnostics', () => {
    const out = sanitizeLogFields({
      scope: 'provider',
      code: 'PROVIDER_HTTP',
      provider: 'openrouter',
      status: 400,
      kind: 'http',
      model: 'openai/gpt-5.6-luna-pro',
      providerMessage: 'Invalid model id',
      message: 'should be stripped'
    }) as Record<string, unknown>
    expect(out.providerMessage).toBe('Invalid model id')
    expect(out.model).toBe('openai/gpt-5.6-luna-pro')
    expect(out.message).toBeUndefined()
  })

  it('sanitizes error objects to taxonomy only', () => {
    const err = new AppError('File not found: C:\\Users\\me\\payroll.xlsx', {
      code: 'TOOL_EXEC',
      context: { path: 'payroll.xlsx' }
    })
    const out = sanitizeErrorForLog(err) as Record<string, unknown>
    expect(out.code).toBe('TOOL_EXEC')
    expect(out.message).toBeUndefined()
    expect(out.context).toBeUndefined()
  })

  it('preserves scrubbed message for string errors (not fake IPC_CLIENT)', () => {
    const out = sanitizeErrorForLog('spawn uvx ENOENT') as Record<string, unknown>
    expect(out.code).toBeUndefined()
    expect(out.message).toContain('ENOENT')
    expect(String(out.message)).not.toContain('IPC_CLIENT')
  })

  it('redacts OpenAI masked API key echoes in providerMessage', () => {
    const out = sanitizeLogFields({
      scope: 'provider',
      providerMessage:
        'Incorrect API key provided: 0e2be96e*********************************************ftCM.'
    }) as Record<string, unknown>
    expect(String(out.providerMessage)).toContain('[redacted]')
    expect(String(out.providerMessage)).not.toContain('0e2be96e')
    expect(String(out.providerMessage)).not.toContain('ftCM')
  })

  it('redacts user paths and file names from log messages', () => {
    const msg = sanitizeLogMessage('File not found: C:\\Users\\me\\src\\auth.ts')
    expect(msg).not.toContain('auth.ts')
    expect(msg).not.toContain('Users')
    expect(msg).toContain('[redacted]')
  })

  it('logErrorSummary avoids workspace-derived error text', () => {
    const summary = logErrorSummary(new Error('File not found: C:\\secret\\keys.env'), 'TOOL_EXEC')
    expect(summary).not.toContain('keys.env')
    expect(summary).toContain('TOOL_EXEC')
  })

  it('workspaceIdFromPath is stable and opaque', () => {
    const a = workspaceIdFromPath('C:\\proj\\a')
    const b = workspaceIdFromPath('C:\\proj\\a')
    const c = workspaceIdFromPath('C:\\proj\\b')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('scrubSentryEvent removes exception text and path-like stack frames', () => {
    const event = scrubSentryEvent({
      message: 'File not found: C:\\Users\\me\\secret.ts',
      exception: {
        values: [
          {
            value: 'sensitive provider body',
            stacktrace: {
              frames: [{ filename: 'C:\\Users\\me\\proj\\auth.ts', abs_path: 'C:\\Users\\me\\proj\\auth.ts' }]
            }
          }
        ]
      }
    }) as {
      message?: string
      exception?: { values?: Array<{ value?: string; stacktrace?: { frames?: Array<{ filename?: string; abs_path?: string }> } }> }
    }
    expect(event.message).toContain('[redacted]')
    expect(event.exception?.values?.[0]?.value).toBeUndefined()
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe('[path]/auth.ts')
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.abs_path).toBeUndefined()
  })
})

describe('logger facade', () => {
  const previous = getLoggerBackend()

  beforeEach(() => {
    setLoggerBackend({
      log: () => undefined
      // no captureException — Sentry disabled
    })
  })

  afterEach(() => {
    setLoggerBackend(previous)
  })

  it('does not throw when Sentry capture is absent', () => {
    expect(() => {
      logger.debug('d')
      logger.info('i')
      logger.warn('w')
      logger.error('e', { err: new Error('x'), scope: 'test' })
      logger.fatal('f', { err: new Error('y') })
      logger.exception(new AppError('z', { code: 'UNCAUGHT' }))
    }).not.toThrow()
  })

  it('invokes captureException for unexpected errors when provided', () => {
    const capture = vi.fn()
    setLoggerBackend({
      log: () => undefined,
      captureException: capture
    })
    logger.exception(new AppError('boom', { code: 'AGENT_LOOP' }))
    expect(capture).toHaveBeenCalled()
  })

  it('does not capture expected validation errors', () => {
    const capture = vi.fn()
    setLoggerBackend({
      log: () => undefined,
      captureException: capture
    })
    logger.exception(new AppError('bad', { code: 'IPC_VALIDATION' }))
    expect(capture).not.toHaveBeenCalled()
  })

  it('does not capture ZodError via logger.error', () => {
    const capture = vi.fn()
    const log = vi.fn()
    setLoggerBackend({ log, captureException: capture })
    let zodErr: unknown
    try {
      z.string().min(1).parse('')
    } catch (err) {
      zodErr = err
    }
    logger.error('validation', { err: zodErr })
    expect(capture).not.toHaveBeenCalled()
  })

  it('scrubs secrets in messages before backend.log', () => {
    const log = vi.fn()
    setLoggerBackend({ log })
    logger.info('using sk-abcdefghijklmnop now')
    expect(log).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('[redacted]'),
      undefined
    )
    expect(String(log.mock.calls[0][1])).not.toContain('sk-abcdefghijklmnop')
  })

  it('captures fatal without err when backend supports it', () => {
    const capture = vi.fn()
    setLoggerBackend({
      log: () => undefined,
      captureException: capture
    })
    logger.fatal('disk full')
    expect(capture).toHaveBeenCalledWith({ name: 'Error', message: 'disk full' }, undefined)
  })

  it('does not throw when the backend log throws', () => {
    setLoggerBackend({
      log: () => {
        throw new Error('backend down')
      }
    })
    expect(() => logger.info('still safe')).not.toThrow()
  })
})
