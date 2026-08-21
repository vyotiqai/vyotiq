import { describe, expect, it } from 'vitest'
import { normalizeBrowserUrl } from '@main/app/browserUrl'
import { isSyncBlockedUrl } from '@main/agent/tools/webFetch'

describe('normalizeBrowserUrl', () => {
  it('accepts localhost and loopback', () => {
    expect(normalizeBrowserUrl('http://localhost:3000/path').href).toBe('http://localhost:3000/path')
    expect(normalizeBrowserUrl('http://127.0.0.1:8080').href).toBe('http://127.0.0.1:8080/')
  })

  it('accepts private LAN hosts', () => {
    expect(normalizeBrowserUrl('http://192.168.1.42/admin').href).toBe(
      'http://192.168.1.42/admin'
    )
    expect(normalizeBrowserUrl('http://10.0.0.5').href).toBe('http://10.0.0.5/')
  })

  it('adds https scheme when missing', () => {
    expect(normalizeBrowserUrl('example.com').href).toBe('https://example.com/')
  })

  it('rejects empty and non-http(s) schemes', () => {
    expect(() => normalizeBrowserUrl('')).toThrow(/required/i)
    expect(() => normalizeBrowserUrl('file:///etc/passwd')).toThrow(/Unsupported URL scheme/)
  })
})

describe('Ask/Plan browser URL gate', () => {
  it('blocks private hosts when allowLocal is false', () => {
    expect(isSyncBlockedUrl('http://127.0.0.1:8080', false)).toBe(true)
    expect(isSyncBlockedUrl('http://localhost/x', false)).toBe(true)
    expect(isSyncBlockedUrl('http://192.168.1.1/', false)).toBe(true)
    expect(isSyncBlockedUrl('https://example.com/', false)).toBe(false)
  })

  it('allows private hosts when allowLocal is true (Agent)', () => {
    expect(isSyncBlockedUrl('http://127.0.0.1:8080', true)).toBe(false)
    expect(isSyncBlockedUrl('http://192.168.1.1/', true)).toBe(false)
  })
})
