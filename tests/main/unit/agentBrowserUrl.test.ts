import { describe, expect, it } from 'vitest'
import { normalizeBrowserUrl } from '@main/app/browserUrl'

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
