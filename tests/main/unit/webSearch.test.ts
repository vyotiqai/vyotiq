import { describe, expect, it } from 'vitest'
import { parseDdgHtmlResults, unwrapSearchHref } from '@main/agent/tools/webSearch'

describe('unwrapSearchHref', () => {
  it('unwraps DuckDuckGo redirect links', () => {
    const wrapped =
      'https://duckduckgo.com/l/?uddg=' + encodeURIComponent('https://example.com/path?q=1')
    expect(unwrapSearchHref(wrapped)).toBe('https://example.com/path?q=1')
  })

  it('passes through direct http(s) links', () => {
    expect(unwrapSearchHref('https://example.com/')).toBe('https://example.com/')
  })
})

describe('parseDdgHtmlResults', () => {
  it('extracts title, url, and snippet from result blocks', () => {
    const html = `
      <body>
        <div class="result results_links">
          <a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://a.example/')}">Alpha Title</a>
          <a class="result__snippet">Alpha snippet text</a>
        </div>
        <div class="result results_links">
          <a class="result__a" href="https://b.example/page">Beta Title</a>
          <a class="result__snippet">Beta snippet</a>
        </div>
      </body>
    `
    const hits = parseDdgHtmlResults(html, 8)
    expect(hits).toEqual([
      { title: 'Alpha Title', url: 'https://a.example/', snippet: 'Alpha snippet text' },
      { title: 'Beta Title', url: 'https://b.example/page', snippet: 'Beta snippet' }
    ])
  })

  it('respects maxResults and dedupes URLs', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://same.example/">One</a>
        <a class="result__snippet">s1</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://same.example/">Two</a>
        <a class="result__snippet">s2</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://other.example/">Three</a>
        <a class="result__snippet">s3</a>
      </div>
    `
    const hits = parseDdgHtmlResults(html, 1)
    expect(hits).toHaveLength(1)
    expect(hits[0].url).toBe('https://same.example/')
  })
})
