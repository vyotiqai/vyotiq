import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertPublicUrl,
  createPinnedLookup,
  isSyncBlockedUrl,
  resetDnsLookupForTests,
  setDnsLookupForTests,
  setPublicFetchForTests,
  toolWebFetch
} from '@main/agent/tools/webFetch'

const PUBLIC_IP = '93.184.216.34'
const PUBLIC_IPV6 = '2606:2800:220:1:248:1893:25c8:1946'

afterEach(() => {
  resetDnsLookupForTests()
  setPublicFetchForTests(null)
  vi.restoreAllMocks()
})

describe('createPinnedLookup', () => {
  it('returns a single address when options.all is false', () => {
    const lookup = createPinnedLookup([PUBLIC_IP, PUBLIC_IPV6])
    let result: unknown
    lookup('example.com', { family: 0 }, ((err, address, family) => {
      expect(err).toBeNull()
      result = { address, family }
    }) as never)
    expect(result).toEqual({ address: PUBLIC_IP, family: 4 })
  })

  it('returns [{address,family}] when options.all is true (Node 20 Happy Eyeballs)', () => {
    const lookup = createPinnedLookup([PUBLIC_IP, PUBLIC_IPV6])
    let result: unknown
    lookup('example.com', { all: true }, ((err, addresses) => {
      expect(err).toBeNull()
      result = addresses
    }) as never)
    expect(result).toEqual([
      { address: PUBLIC_IP, family: 4 },
      { address: PUBLIC_IPV6, family: 6 }
    ])
  })

  it('rejects when no public addresses remain', () => {
    expect(() => createPinnedLookup(['127.0.0.1'])).toThrow(/private or loopback/)
  })
})

describe('assertPublicUrl', () => {
  it('rejects loopback hostnames and private IPv4 literals', async () => {
    await expect(assertPublicUrl('http://localhost/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://127.1/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://2130706433/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://192.168.1.1/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://169.254.169.254/')).rejects.toThrow(/private or loopback/)
  })

  it('rejects private IPv6 literals', async () => {
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://[fe80::1]/')).rejects.toThrow(/private or loopback/)
  })

  it('rejects hostnames that resolve to private addresses', async () => {
    setDnsLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }])

    await expect(assertPublicUrl('http://example.test/')).rejects.toThrow(/private or loopback/)
  })

  it('allows public hostnames that resolve to public addresses', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])

    const url = await assertPublicUrl('http://example.test/')
    expect(url.hostname).toBe('example.test')
  })
})

describe('isSyncBlockedUrl', () => {
  it('blocks private literals and non-http protocols without DNS', () => {
    expect(isSyncBlockedUrl('http://127.0.0.1/')).toBe(true)
    expect(isSyncBlockedUrl('http://localhost/')).toBe(true)
    expect(isSyncBlockedUrl('http://192.168.0.1/')).toBe(true)
    expect(isSyncBlockedUrl('http://2130706433/')).toBe(true)
    expect(isSyncBlockedUrl('http://127.1/')).toBe(true)
    expect(isSyncBlockedUrl('file:///etc/passwd')).toBe(true)
    expect(isSyncBlockedUrl('not a url')).toBe(true)
  })

  it('allows public hostnames pending DNS (assertPublicUrl after load)', () => {
    expect(isSyncBlockedUrl('https://example.com/')).toBe(false)
    expect(isSyncBlockedUrl(`http://${PUBLIC_IP}/`)).toBe(false)
  })
})

describe('toolWebFetch redirects', () => {
  it('rejects redirects to private hosts', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:11434/' }
      })
    })
    setPublicFetchForTests(fetchMock)

    await expect(toolWebFetch(`https://${PUBLIC_IP}/`)).rejects.toThrow(/private or loopback/)
  })

  it('follows safe redirects and validates each hop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: `https://${PUBLIC_IP}/final` }
        })
      )
      .mockResolvedValueOnce(
        new Response('<html><body><p>hello</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
      )
    setPublicFetchForTests(fetchMock)

    const out = await toolWebFetch(`https://${PUBLIC_IP}/start`)
    expect(out).toContain(`# https://${PUBLIC_IP}/final`)
    expect(out).toContain('hello')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
