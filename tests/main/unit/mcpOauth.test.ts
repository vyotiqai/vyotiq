import { describe, expect, it, vi } from 'vitest'

// oauth.ts has no pure, side-effect-free token/URL helpers exported (PKCE and
// redirect URL building live inside the MCP SDK / localhost HTTP server which
// bind sockets and shell out to Electron). We therefore mock electron + the
// secrets store and exercise the deterministic, network-free surface of
// createMcpOAuthProvider: its redirect URL getter, client metadata, and the
// invalidateCredentials state clears.

const clearMcpOAuthState = vi.fn()
const setMcpOAuthState = vi.fn()
const patchMcpOAuthState = vi.fn()
const getMcpOAuthState = vi.fn(() => ({}))

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() }
}))
vi.mock('@main/settings/secrets', () => ({
  clearMcpOAuthState: (...args: unknown[]) => clearMcpOAuthState(...args),
  setMcpOAuthState: (...args: unknown[]) => setMcpOAuthState(...args),
  patchMcpOAuthState: (...args: unknown[]) => patchMcpOAuthState(...args),
  getMcpOAuthState: (...args: unknown[]) => getMcpOAuthState(...args)
}))

import { createMcpOAuthProvider } from '@main/agent/mcp/oauth'

describe('createMcpOAuthProvider', () => {
  it('exposes the redirect URL verbatim', () => {
    const provider = createMcpOAuthProvider('srv-1', 'http://127.0.0.1:9999/oauth/callback')
    expect(provider.serverId).toBe('srv-1')
    expect(provider.redirectUrl).toBe('http://127.0.0.1:9999/oauth/callback')
  })

  it('builds the expected client metadata', () => {
    const provider = createMcpOAuthProvider('srv-2', 'https://cb.example/oauth/callback')
    expect(provider.clientMetadata).toMatchObject({
      client_name: 'Vyotiq',
      redirect_uris: ['https://cb.example/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  })

  it('clearMcpOAuthState on invalidateCredentials(all)', () => {
    const provider = createMcpOAuthProvider('srv-3', 'http://127.0.0.1/cb')
    provider.invalidateCredentials('all')
    expect(clearMcpOAuthState).toHaveBeenCalledWith('srv-3')
  })

  it('delegates token persistence to the secrets store', () => {
    getMcpOAuthState.mockReturnValue({})
    const provider = createMcpOAuthProvider('srv-4', 'http://127.0.0.1/cb')
    provider.saveTokens({ access_token: 'abc' } as never)
    expect(patchMcpOAuthState).toHaveBeenCalledWith('srv-4', { tokens: { access_token: 'abc' } })
  })
})
