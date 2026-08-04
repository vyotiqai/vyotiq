import { ZodError } from 'zod'
import { scrubString } from './scrub'

export type ErrorCode =
  | 'AGENT_LOOP'
  | 'AGENT_QUESTION'
  | 'CATALOG_PROBE'
  | 'IPC_VALIDATION'
  | 'IPC_HANDLER'
  | 'IPC_CLIENT'
  | 'MCP_CONNECT'
  | 'MCP_SPAWN'
  | 'RENDERER_CRASH'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_HTTP'
  | 'PROVIDER_RATE'
  | 'PROVIDER_STREAM'
  | 'PROVIDER_TIMEOUT'
  | 'SECRETS'
  | 'SETTINGS'
  | 'TOOL_APPROVAL'
  | 'TOOL_EXEC'
  | 'UNCAUGHT'
  | 'WORKSPACE'

export type ErrorSeverity = 'error' | 'warn' | 'info' | 'fatal'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly severity: ErrorSeverity
  readonly retriable: boolean
  readonly correlationId?: string
  readonly context?: Record<string, unknown>

  constructor(
    message: string,
    opts?: {
      code?: ErrorCode
      severity?: ErrorSeverity
      retriable?: boolean
      correlationId?: string
      cause?: unknown
      context?: Record<string, unknown>
    }
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'AppError'
    this.code = opts?.code ?? 'AGENT_LOOP'
    this.severity = opts?.severity ?? 'error'
    this.retriable = opts?.retriable ?? false
    this.correlationId = opts?.correlationId
    this.context = opts?.context
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  if (isAppError(err) && err.cause instanceof DOMException && err.cause.name === 'AbortError') {
    return true
  }
  return false
}

export function isExpectedToolError(message: string): boolean {
  if (/Command timed out after \d+ms/i.test(message)) return false
  return /File not found|Not a file|Path is a directory|Path escapes workspace|No matches|Unsupported Unix command|Invalid memory path|Binary file detected|MCP server not connected/i.test(
    message
  )
}

// IPC_CLIENT is a failure the other side already handled and returned as a string,
// so it must not be re-reported as an unexpected crash. MCP connect/spawn failures
// are operator/config issues, not app crashes.
const EXPECTED_CODES = new Set<ErrorCode>([
  'IPC_VALIDATION',
  'IPC_CLIENT',
  'MCP_CONNECT',
  'MCP_SPAWN'
])

/** Classify stdio/spawn failures vs generic MCP connect errors. */
export function mcpConnectErrorCode(err: unknown): 'MCP_SPAWN' | 'MCP_CONNECT' {
  if (!err || typeof err !== 'object') return 'MCP_CONNECT'
  const code = (err as { code?: unknown }).code
  if (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ENOTDIR' ||
    code === 'EINVAL'
  ) {
    return 'MCP_SPAWN'
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/ENOENT|spawn |uvx|uv\.exe|not found|is not recognized/i.test(message)) {
    return 'MCP_SPAWN'
  }
  return 'MCP_CONNECT'
}

export function isExpectedError(err: unknown): boolean {
  if (isAbortError(err)) return true
  if (err instanceof ZodError) return true
  if (isAppError(err)) {
    if (EXPECTED_CODES.has(err.code)) return true
    if (isAbortError(err.cause)) return true
    return false
  }
  return false
}

export function createCorrelationId(): string {
  // Shared by main and renderer, so use the Web Crypto global rather than node:crypto.
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid.replace(/-/g, '').slice(0, 16)
  return Math.random().toString(16).slice(2).padEnd(16, '0').slice(0, 16)
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'value'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

export function formatError(err: unknown): string {
  if (err == null) return 'Unknown error'
  if (isAppError(err)) {
    const parts = [scrubString(err.message)]
    if (err.cause instanceof Error && err.cause.message) {
      parts.push(scrubString(err.cause.message))
    }
    return parts.filter(Boolean).join(' — ') || 'Unknown error'
  }
  if (err instanceof ZodError) return scrubString(formatZodError(err))
  if (err instanceof Error) {
    const parts = [scrubString(err.message)]
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) {
      parts.push(scrubString(cause.message))
    }
    return parts.filter(Boolean).join(' — ')
  }
  return scrubString(String(err))
}

export function toAppError(
  err: unknown,
  opts?: { code?: ErrorCode; correlationId?: string; cause?: unknown }
): AppError {
  if (isAppError(err)) {
    if (opts?.correlationId && !err.correlationId) {
      return new AppError(err.message, {
        code: opts.code ?? err.code,
        correlationId: opts.correlationId,
        cause: err.cause,
        context: err.context
      })
    }
    return err
  }
  if (err instanceof ZodError) {
    return new AppError(formatZodError(err), {
      code: opts?.code ?? 'IPC_VALIDATION',
      correlationId: opts?.correlationId,
      cause: err
    })
  }
  if (err instanceof Error) {
    return new AppError(err.message, {
      code: opts?.code ?? 'AGENT_LOOP',
      correlationId: opts?.correlationId,
      cause: opts?.cause ?? err
    })
  }
  return new AppError(String(err), {
    code: opts?.code ?? 'IPC_CLIENT',
    correlationId: opts?.correlationId,
    cause: opts?.cause
  })
}

export function toLogErr(message: string): AppError {
  return new AppError(message, { code: 'IPC_CLIENT' })
}
