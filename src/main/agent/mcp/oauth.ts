import { createServer, type Server } from 'http'
import { shell } from 'electron'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  clearMcpOAuthState,
  getMcpOAuthState,
  patchMcpOAuthState,
  setMcpOAuthState,
  type McpOAuthStoredState
} from '../../settings/secrets'
import { logger } from '../../../shared/logger'

const CALLBACK_PATH = '/oauth/callback'
const CALLBACK_TIMEOUT_MS = 5 * 60_000

type PendingAuth = {
  resolve: (code: string) => void
  reject: (err: Error) => void
  server: Server
  timer: ReturnType<typeof setTimeout>
}

const pendingByServerId = new Map<string, PendingAuth>()

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;padding:2rem"><h1>${title}</h1><p>${body}</p></body></html>`
}

/**
 * Start a one-shot localhost HTTP server to receive the OAuth redirect.
 * Returns the redirect URL (http://127.0.0.1:<port>/oauth/callback).
 */
export async function beginMcpOAuthCallback(serverId: string): Promise<{
  redirectUrl: string
  waitForCode: () => Promise<string>
}> {
  cancelMcpOAuthCallback(serverId, new Error('OAuth callback superseded'))

  const server = createServer()
  const listenPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind OAuth callback server'))
        return
      }
      resolve(addr.port)
    })
  })

  const redirectUrl = `http://127.0.0.1:${listenPort}${CALLBACK_PATH}`

  let settleCode: ((code: string) => void) | null = null
  let settleErr: ((err: Error) => void) | null = null
  const codePromise = new Promise<string>((resolve, reject) => {
    settleCode = resolve
    settleErr = reject
  })

  const timer = setTimeout(() => {
    cancelMcpOAuthCallback(serverId, new Error('OAuth callback timed out'))
  }, CALLBACK_TIMEOUT_MS)

  const pending: PendingAuth = {
    resolve: (code) => settleCode?.(code),
    reject: (err) => settleErr?.(err),
    server,
    timer
  }
  pendingByServerId.set(serverId, pending)

  server.on('request', (req, res) => {
    try {
      const remote = req.socket.remoteAddress
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(htmlPage('Forbidden', 'OAuth callback must come from localhost.'))
        return
      }
      const url = new URL(req.url ?? '/', redirectUrl)
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(htmlPage('Not found', 'Unexpected path.'))
        return
      }
      const err = url.searchParams.get('error')
      const desc = url.searchParams.get('error_description')
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(htmlPage('Authorization failed', desc || err))
        cancelMcpOAuthCallback(serverId, new Error(desc || err))
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(htmlPage('Authorization failed', 'Missing authorization code.'))
        cancelMcpOAuthCallback(serverId, new Error('Missing authorization code'))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(htmlPage('Connected', 'You can close this window and return to Vyotiq.'))
      clearTimeout(timer)
      pendingByServerId.delete(serverId)
      try {
        server.close()
      } catch {
        // ignore
      }
      pending.resolve(code)
    } catch (e) {
      cancelMcpOAuthCallback(
        serverId,
        e instanceof Error ? e : new Error('OAuth callback error')
      )
    }
  })

  return {
    redirectUrl,
    waitForCode: () => codePromise
  }
}

export function cancelMcpOAuthCallback(serverId: string, err?: Error): void {
  const pending = pendingByServerId.get(serverId)
  if (!pending) return
  pendingByServerId.delete(serverId)
  clearTimeout(pending.timer)
  try {
    pending.server.close()
  } catch {
    // ignore
  }
  if (err) pending.reject(err)
}

export type VyotiqMcpOAuthProvider = OAuthClientProvider & {
  readonly serverId: string
  readonly redirectUrl: string
}

/**
 * MCP SDK OAuthClientProvider backed by Electron safeStorage.
 * Uses a localhost redirect URL for the Authorization Code + PKCE flow.
 */
export function createMcpOAuthProvider(
  serverId: string,
  redirectUrl: string
): VyotiqMcpOAuthProvider {
  const read = (): McpOAuthStoredState => getMcpOAuthState(serverId) ?? {}

  return {
    serverId,
    get redirectUrl() {
      return redirectUrl
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'Vyotiq',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      }
    },
    clientInformation(): OAuthClientInformationMixed | undefined {
      const info = read().clientInformation
      return info as OAuthClientInformationMixed | undefined
    },
    saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
      patchMcpOAuthState(serverId, {
        clientInformation: clientInformation as Record<string, unknown>
      })
    },
    tokens(): OAuthTokens | undefined {
      const tokens = read().tokens
      if (!tokens?.access_token) return undefined
      return tokens as OAuthTokens
    },
    saveTokens(tokens: OAuthTokens): void {
      patchMcpOAuthState(serverId, { tokens: tokens as McpOAuthStoredState['tokens'] })
    },
    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      logger.info('Opening MCP OAuth authorization URL', {
        scope: 'mcp',
        serverId,
        host: authorizationUrl.host
      })
      if (authorizationUrl.protocol !== 'https:') {
        throw new Error('MCP OAuth authorization URL must be https')
      }
      await shell.openExternal(authorizationUrl.toString())
    },
    saveCodeVerifier(codeVerifier: string): void {
      patchMcpOAuthState(serverId, { codeVerifier })
    },
    codeVerifier(): string {
      const v = read().codeVerifier
      if (!v) throw new Error('Missing PKCE code verifier for MCP OAuth')
      return v
    },
    saveDiscoveryState(state): void {
      patchMcpOAuthState(serverId, {
        discoveryState: state as unknown as Record<string, unknown>
      })
    },
    discoveryState(): OAuthDiscoveryState | undefined {
      const state = read().discoveryState
      if (!state) return undefined
      return state as unknown as OAuthDiscoveryState
    },
    async invalidateCredentials(scope): Promise<void> {
      if (scope === 'all') {
        clearMcpOAuthState(serverId)
        return
      }
      const prev = { ...read() }
      if (scope === 'tokens') {
        delete prev.tokens
        setMcpOAuthState(serverId, prev)
        return
      }
      if (scope === 'verifier') {
        delete prev.codeVerifier
        setMcpOAuthState(serverId, prev)
        return
      }
      if (scope === 'client') {
        delete prev.clientInformation
        setMcpOAuthState(serverId, prev)
        return
      }
      if (scope === 'discovery') {
        delete prev.discoveryState
        setMcpOAuthState(serverId, prev)
        return
      }
      const _exhaustive: never = scope
      void _exhaustive
    }
  }
}
