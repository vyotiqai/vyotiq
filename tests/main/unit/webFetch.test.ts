import * as http from 'http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertPublicUrl,
  createPinnedLookup,
  fetchPublicResponse,
  fetchWithValidatedRedirects,
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
    await expect(assertPublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://[::ffff:7f00:1]/')).rejects.toThrow(/private or loopback/)
    await expect(assertPublicUrl('http://[0:0:0:0:0:ffff:127.0.0.1]/')).rejects.toThrow(
      /private or loopback/
    )
    await expect(
      assertPublicUrl('http://[0000:0000:0000:0000:0000:0000:0000:0001]/')
    ).rejects.toThrow(/private or loopback/)
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
    expect(isSyncBlockedUrl('http://[::ffff:7f00:1]/')).toBe(true)
    expect(isSyncBlockedUrl('http://[::1]/')).toBe(true)
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

  it('appends SPA shell warning for nav-heavy HTML', async () => {
    const html =
      '<html><body><header><nav><ul>' +
      '<li><a href="/models">Models</a></li>' +
      '<li><a href="/datasets">Datasets</a></li>' +
      '<li><a href="/spaces">Spaces</a></li>' +
      '<li><a href="/docs">Docs</a></li>' +
      '<li><a href="/enterprise">Enterprise</a></li>' +
      '</ul></nav></header></body></html>'
    setPublicFetchForTests(
      vi.fn(async () =>
        new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      )
    )

    const out = await toolWebFetch(`https://${PUBLIC_IP}/hf-model`)
    expect(out).toMatch(/JavaScript-rendered/i)
  })

  it('throws AbortError when aborted during network retry backoff', async () => {
    vi.useFakeTimers()
    try {
      const err = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
      setPublicFetchForTests(vi.fn(async () => {
        throw err
      }))
      const controller = new AbortController()
      const pending = toolWebFetch(`https://${PUBLIC_IP}/`, {}, controller.signal)
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transient network error then returns the page', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))
        .mockResolvedValueOnce(
          new Response('<html><body><p>recovered</p></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' }
          })
        )
      setPublicFetchForTests(fetchMock)
      const pending = toolWebFetch(`https://${PUBLIC_IP}/`)
      await vi.runAllTimersAsync()
      const out = await pending
      expect(out).toContain('recovered')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries HTTP 503 then returns the page', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('unavailable', { status: 503, statusText: 'Unavailable' }))
        .mockResolvedValueOnce(
          new Response('<html><body><p>recovered-503</p></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' }
          })
        )
      setPublicFetchForTests(fetchMock)
      const pending = toolWebFetch(`https://${PUBLIC_IP}/`)
      await vi.runAllTimersAsync()
      const out = await pending
      expect(out).toContain('recovered-503')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fetchPublicResponse retries', () => {
  it('retries HTTP 503 then returns the successful body', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
        .mockResolvedValueOnce(
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        )
      setPublicFetchForTests(fetchMock)
      const pending = fetchPublicResponse(
        new URL(`https://${PUBLIC_IP}/v1/catalog`),
        new AbortController().signal,
        { accept: 'application/json' }
      )
      await vi.runAllTimersAsync()
      const result = await pending
      expect(result.response.status).toBe(200)
      expect(result.body.toString('utf8')).toBe('{"ok":true}')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry HTTP 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status: 401 }))
    setPublicFetchForTests(fetchMock)
    const result = await fetchPublicResponse(
      new URL(`https://${PUBLIC_IP}/v1/catalog`),
      new AbortController().signal
    )
    expect(result.response.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to follow redirects on POST', async () => {
    setDnsLookupForTests(async () => [{ address: PUBLIC_IP, family: 4 }])
    setPublicFetchForTests(
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://${PUBLIC_IP}/elsewhere` }
        })
      )
    )
    await expect(
      fetchWithValidatedRedirects(
        new URL(`https://${PUBLIC_IP}/api/show`),
        AbortSignal.timeout(2000),
        { 'Content-Type': 'application/json' },
        false,
        { method: 'POST', body: '{"model":"x"}' }
      )
    ).rejects.toThrow(/Refusing to follow 302 redirect on POST/)
  })

  it('already-aborted pinned fetch rejects AbortError without uncaughtException', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (!addr || typeof addr === 'string') {
      server.close()
      throw new Error('expected TCP listen address')
    }
    const uncaught: Error[] = []
    const onUncaught = (err: Error): void => {
      uncaught.push(err)
    }
    process.on('uncaughtException', onUncaught)
    try {
      // fetchPublicResponse uses this same DNS-pinned ClientRequest path.
      // allowLocal is required so the in-process server is not blocked by SSRF.
      await expect(
        fetchWithValidatedRedirects(
          new URL(`http://127.0.0.1:${addr.port}/`),
          AbortSignal.abort(),
          undefined,
          true
        )
      ).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  })
})
