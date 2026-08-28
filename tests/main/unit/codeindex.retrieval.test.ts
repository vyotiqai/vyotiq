import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodeIndexStore,
  collectDocsLexicalHits,
  createLocalHashEmbedder,
  createOllamaEmbedder,
  searchCodeIndex,
  sanitizeFtsQuery,
  storeEmbeddingsMatchEmbedder,
  syncCodeIndex
} from '@main/agent/codeindex'
import { DENSEON_ONNX_MODEL_ID, MDENSEON_MODEL_ID } from '@main/agent/codeindex/types'
import { toolCodebaseSearch } from '@main/agent/tools/codebaseSearch'
import { closeCodeIndex } from '@main/agent/codeindex'
import { minimalDocx } from './helpers/minimalDocx'

describe('codeindex sync + retrieval', () => {
  let dir: string

  afterEach(() => {
    if (dir) {
      closeCodeIndex(dir)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function seedFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      `export function validateAuthToken(token: string): boolean {
  if (!token) return false
  return token.startsWith('Bearer ')
}

export function hashPassword(password: string): string {
  return password.split('').reverse().join('')
}
`,
      'utf8'
    )
    writeFileSync(
      join(root, 'src', 'billing.ts'),
      `export function processRefund(orderId: string): void {
  const amount = 10
  console.log('refund', orderId, amount)
}

export function calculateTax(cents: number): number {
  return Math.round(cents * 0.1)
}
`,
      'utf8'
    )
    return root
  }

  it('skips re-embed when file hash unchanged', async () => {
    dir = seedFixture()
    const embedder = createLocalHashEmbedder()
    const store = CodeIndexStore.open(dir, embedder.dimensions)
    try {
      const first = await syncCodeIndex(dir, store, embedder)
      expect(first.indexed).toBeGreaterThan(0)
      const second = await syncCodeIndex(dir, store, embedder)
      expect(second.indexed).toBe(0)
      expect(second.skipped).toBeGreaterThan(0)
      expect(store.getStatus().chunkCount).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  it('reindexes only the changed file', async () => {
    dir = seedFixture()
    const embedder = createLocalHashEmbedder()
    const store = CodeIndexStore.open(dir, embedder.dimensions)
    try {
      await syncCodeIndex(dir, store, embedder)
      writeFileSync(
        join(dir, 'src', 'billing.ts'),
        `export function processRefund(orderId: string): void {
  console.log('updated refund flow', orderId)
}
`,
        'utf8'
      )
      const again = await syncCodeIndex(dir, store, embedder)
      expect(again.indexed).toBe(1)
      expect(again.skipped).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  it('golden hybrid retrieval finds auth and refund symbols', async () => {
    dir = seedFixture()
    const embedder = createLocalHashEmbedder()
    const store = CodeIndexStore.open(dir, embedder.dimensions)
    try {
      await syncCodeIndex(dir, store, embedder)

      const authHits = await searchCodeIndex(dir, store, embedder, 'validate auth token Bearer', {
        mode: 'hybrid',
        limit: 5
      })
      expect(authHits.some((h) => h.path.includes('auth') || h.name.includes('validateAuth'))).toBe(
        true
      )

      const refundHits = await searchCodeIndex(dir, store, embedder, 'process refund', {
        mode: 'hybrid',
        limit: 5
      })
      expect(
        refundHits.some((h) => h.path.includes('billing') || h.name.includes('processRefund'))
      ).toBe(true)

      const exactHits = await searchCodeIndex(dir, store, embedder, 'calculateTax', {
        mode: 'lexical',
        limit: 5
      })
      expect(exactHits.some((h) => h.name === 'calculateTax' || h.snippet.includes('calculateTax'))).toBe(
        true
      )
    } finally {
      store.close()
    }
  })

  it('returns a snippet for hits whose lines start after 256KB', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-late-snippet-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    const pad = Array.from(
      { length: 80 },
      (_, i) => `export const pad${i} = '${'x'.repeat(4000)}'`
    ).join('\n')
    writeFileSync(
      join(dir, 'src', 'late.ts'),
      `${pad}\nexport function lateHitMarker() {\n  return 1\n}\n`,
      'utf8'
    )
    const embedder = createLocalHashEmbedder()
    const store = CodeIndexStore.open(dir, embedder.dimensions)
    try {
      await syncCodeIndex(dir, store, embedder)
      const hits = await searchCodeIndex(dir, store, embedder, 'lateHitMarker', {
        mode: 'lexical',
        limit: 5
      })
      const hit = hits.find((h) => h.name === 'lateHitMarker' || h.snippet.includes('lateHitMarker'))
      expect(hit).toBeTruthy()
      expect(hit!.startLine).toBeGreaterThan(50)
      expect(hit!.snippet).toContain('lateHitMarker')
    } finally {
      store.close()
    }
  })

  it('golden: conceptual NL hybrid vs lexical baselines', async () => {
    dir = seedFixture()
    const embedder = createLocalHashEmbedder()
    const store = CodeIndexStore.open(dir, embedder.dimensions)
    try {
      await syncCodeIndex(dir, store, embedder)

      // Overlapping tokens so hash embedder can still surface auth conceptually.
      const conceptual = await searchCodeIndex(
        dir,
        store,
        embedder,
        'where do we validate bearer auth tokens',
        { mode: 'hybrid', limit: 8 }
      )
      expect(conceptual.some((h) => h.path.includes('auth'))).toBe(true)

      const lexicalExact = await searchCodeIndex(dir, store, embedder, 'processRefund', {
        mode: 'lexical',
        limit: 5
      })
      expect(lexicalExact[0]?.path.includes('billing') || lexicalExact[0]?.name === 'processRefund').toBe(
        true
      )

      const semanticDense = await searchCodeIndex(dir, store, embedder, 'refund order amount', {
        mode: 'semantic',
        limit: 5
      })
      expect(semanticDense.some((h) => h.path.includes('billing'))).toBe(true)

      // Exact symbol: lexical should beat a mismatched conceptual query on billing.
      const wrongConcept = await searchCodeIndex(dir, store, embedder, 'calculateTax', {
        mode: 'lexical',
        limit: 3
      })
      expect(wrongConcept.some((h) => h.snippet.includes('calculateTax') || h.name === 'calculateTax')).toBe(
        true
      )
    } finally {
      store.close()
    }
  })

  it('hybrid search with hash embedder skips dense cosine', async () => {
    dir = seedFixture()
    const base = createLocalHashEmbedder()
    let embedCalls = 0
    const counting = {
      modelId: base.modelId,
      dimensions: base.dimensions,
      embed(texts: string[], opts?: { role?: 'query' | 'document'; signal?: AbortSignal }) {
        embedCalls++
        return base.embed(texts, opts)
      }
    }
    const store = CodeIndexStore.open(dir, counting.dimensions)
    try {
      await syncCodeIndex(dir, store, counting)
      embedCalls = 0
      const hits = await searchCodeIndex(dir, store, counting, 'validateAuthToken', {
        mode: 'hybrid',
        limit: 5
      })
      expect(embedCalls).toBe(0)
      expect(hits.some((h) => h.path.includes('auth'))).toBe(true)

      embedCalls = 0
      await searchCodeIndex(dir, store, counting, 'validateAuthToken', {
        mode: 'semantic',
        limit: 5
      })
      expect(embedCalls).toBe(1)
    } finally {
      store.close()
    }
  })

  it('splits camelCase in FTS queries', () => {
    const q = sanitizeFtsQuery('validateAuthToken')
    expect(q).toBe('"validateauthtoken" "validate" "auth" "token"')
  })

  it('drops 2-character camelCase pieces from FTS MATCH tokens', () => {
    const q = sanitizeFtsQuery('getById')
    expect(q).toBe('"getbyid" "get"')
    expect(q).not.toContain('"by"')
    expect(q).not.toContain('"id"')
  })

  it('drops NL stopwords from FTS MATCH and joins remaining tokens with AND', () => {
    const q = sanitizeFtsQuery('how does the service worker toggle')
    expect(q).toBe('"service" "worker" "toggle"')
    expect(q).not.toMatch(/\sOR\s/)
    expect(sanitizeFtsQuery('how does the')).toBe('')
  })

  it('lexical search finds a file by path and a camelCase name by split words', async () => {
    dir = seedFixture()
    const embedder = createLocalHashEmbedder()
    const store = CodeIndexStore.open(dir, embedder.dimensions)
    try {
      await syncCodeIndex(dir, store, embedder)
      const byPath = await searchCodeIndex(dir, store, embedder, 'src/auth.ts', {
        mode: 'lexical',
        limit: 5
      })
      expect(byPath.some((h) => h.path.includes('auth.ts'))).toBe(true)

      const byName = await searchCodeIndex(dir, store, embedder, 'calculate tax', {
        mode: 'lexical',
        limit: 5
      })
      expect(byName.some((h) => h.name === 'calculateTax' || h.snippet.includes('calculateTax'))).toBe(
        true
      )
    } finally {
      store.close()
    }
  })

  it('lexical search does not rank a stopword banner over identifier hits', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-banner-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'cosmetic.js'),
      `/**
 * How does the popup work for the user.
 * This is the file that has the docs for the UI.
 * Where does the toggle live for the site.
 */
export function paintCosmetic() {
  return 'theme'
}
`,
      'utf8'
    )
    writeFileSync(
      join(dir, 'src', 'service-worker.js'),
      `export function applyState() {
  // service worker toggle for per-site blocking
  chrome.declarativeNetRequest.updateDynamicRules({ addRules: [] })
}
`,
      'utf8'
    )
    const embedder = createLocalHashEmbedder()
    const store = CodeIndexStore.open(dir, embedder.dimensions)
    try {
      await syncCodeIndex(dir, store, embedder)
      const hits = await searchCodeIndex(
        dir,
        store,
        embedder,
        'how does the service worker toggle',
        { mode: 'lexical', limit: 5 }
      )
      expect(hits[0]?.path).toMatch(/service-worker/)
      expect(
        hits[0]?.name === 'applyState' || hits[0]?.snippet.includes('updateDynamicRules')
      ).toBe(true)
    } finally {
      store.close()
    }
  })

  it('semantic search with a mismatched embedder falls back to lexical', async () => {
    dir = seedFixture()
    const indexed = createLocalHashEmbedder(32, 'lightonai/DenseOn@onnx-int8')
    const store = CodeIndexStore.open(dir, indexed.dimensions)
    try {
      await syncCodeIndex(dir, store, indexed)
      let embedCalls = 0
      const queryEmbedder = {
        modelId: 'local-hash-v1',
        dimensions: 32,
        embed(texts: string[], opts?: { role?: 'query' | 'document'; signal?: AbortSignal }) {
          embedCalls++
          return createLocalHashEmbedder(32).embed(texts, opts)
        }
      }
      const hits = await searchCodeIndex(dir, store, queryEmbedder, 'calculateTax', {
        mode: 'semantic',
        limit: 5
      })
      expect(embedCalls).toBe(0)
      expect(hits.some((h) => h.name === 'calculateTax' || h.path.includes('billing'))).toBe(true)
    } finally {
      store.close()
    }
  })

  it('treats lazy mDenseOn id as compatible with stored DenseOn-ONNX', () => {
    const store = {
      dimensions: 768,
      getMeta: (key: string) => {
        if (key === 'modelId') return DENSEON_ONNX_MODEL_ID
        if (key === 'dimensions') return '768'
        return null
      }
    }
    const embedder = {
      modelId: MDENSEON_MODEL_ID,
      dimensions: 768,
      embed: async () => []
    }
    expect(storeEmbeddingsMatchEmbedder(store, embedder)).toBe(true)
  })

  it('uses dense search when the lazy mDenseOn placeholder matches a DenseOn store', async () => {
    dir = seedFixture()
    const indexed = createLocalHashEmbedder(32, DENSEON_ONNX_MODEL_ID)
    const store = CodeIndexStore.open(dir, indexed.dimensions)
    try {
      await syncCodeIndex(dir, store, indexed)
      let embedCalls = 0
      const queryEmbedder = {
        modelId: MDENSEON_MODEL_ID,
        dimensions: 32,
        embed(texts: string[], opts?: { role?: 'query' | 'document'; signal?: AbortSignal }) {
          embedCalls++
          return indexed.embed(texts, opts)
        }
      }
      const hits = await searchCodeIndex(dir, store, queryEmbedder, 'calculateTax', {
        mode: 'semantic',
        limit: 5
      })
      expect(embedCalls).toBe(1)
      expect(hits.some((h) => h.name === 'calculateTax' || h.path.includes('billing'))).toBe(true)
    } finally {
      store.close()
    }
  })

  it('skips dense search when store modelId meta is missing', async () => {
    dir = seedFixture()
    const indexed = createLocalHashEmbedder(32, 'lightonai/DenseOn@onnx-int8')
    const store = CodeIndexStore.open(dir, indexed.dimensions)
    try {
      await syncCodeIndex(dir, store, indexed)
      store.db.prepare("DELETE FROM meta WHERE key = 'modelId'").run()
      let embedCalls = 0
      const queryEmbedder = {
        modelId: 'lightonai/DenseOn@onnx-int8',
        dimensions: 32,
        embed(texts: string[], opts?: { role?: 'query' | 'document'; signal?: AbortSignal }) {
          embedCalls++
          return indexed.embed(texts, opts)
        }
      }
      const hits = await searchCodeIndex(dir, store, queryEmbedder, 'calculateTax', {
        mode: 'semantic',
        limit: 5
      })
      expect(embedCalls).toBe(0)
      expect(hits.some((h) => h.name === 'calculateTax' || h.path.includes('billing'))).toBe(true)
    } finally {
      store.close()
    }
  })

  it('toolCodebaseSearch returns formatted hits', async () => {
    dir = seedFixture()
    const out = await toolCodebaseSearch(dir, 'validate auth token', {
      maxResults: 5,
      mode: 'hybrid',
      preferOllama: false
    })
    expect(out).toMatch(/index:/)
    expect(out).toMatch(/fallback=hash/)
    expect(out.toLowerCase()).toMatch(/auth|validate/)
  })

  it('search-time matches Word .docx under docs/ that the source index omits', async () => {
    dir = seedFixture()
    mkdirSync(join(dir, 'docs', 'reference'), { recursive: true })
    writeFileSync(
      join(dir, 'docs', 'reference', '15-architecture.md.docx'),
      minimalDocx(['UniqueArchDocxHit process model for the Electron agent'])
    )
    const out = await toolCodebaseSearch(dir, 'UniqueArchDocxHit', {
      maxResults: 5,
      mode: 'hybrid',
      preferOllama: false
    })
    expect(out).toContain('docs/reference/15-architecture.md.docx')
    expect(out).toContain('UniqueArchDocxHit')
  })

  it('docs overlap walks only workspace docs/, not landing markdown', async () => {
    dir = seedFixture()
    mkdirSync(join(dir, 'docs', 'reference'), { recursive: true })
    mkdirSync(join(dir, 'landing', 'src', 'content', 'docs'), { recursive: true })
    writeFileSync(
      join(dir, 'docs', 'reference', '15-architecture.md'),
      'UniqueArchDocxHit in architecture\n',
      'utf8'
    )
    writeFileSync(
      join(dir, 'landing', 'src', 'content', 'docs', 'guide.md'),
      'UniqueArchDocxHit in landing\n',
      'utf8'
    )
    const hits = await collectDocsLexicalHits(dir, 'UniqueArchDocxHit', {
      limit: 5,
      seenPaths: new Set()
    })
    expect(hits.map((h) => h.path)).toEqual(['docs/reference/15-architecture.md'])
  })

  it('docs overlap is a no-op when workspace has no docs/ directory', async () => {
    dir = seedFixture()
    const hits = await collectDocsLexicalHits(dir, 'UniqueArchDocxHit', {
      limit: 5,
      seenPaths: new Set()
    })
    expect(hits).toEqual([])
  })

  it('respects abort during search sync', async () => {
    dir = seedFixture()
    const ac = new AbortController()
    ac.abort()
    await expect(toolCodebaseSearch(dir, 'auth', { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

const OLLAMA_PROBE_URL = 'http://127.0.0.1:11434'

async function probeOllamaNomicEmbed(): Promise<{ ok: boolean; detail: string }> {
  try {
    const tagsRes = await fetch(`${OLLAMA_PROBE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2500)
    })
    if (!tagsRes.ok) {
      return { ok: false, detail: `${OLLAMA_PROBE_URL}/api/tags → HTTP ${tagsRes.status}` }
    }
    const tagsJson = (await tagsRes.json()) as { models?: Array<{ name?: string }> }
    const names = (tagsJson.models ?? []).map((m) => m.name ?? '').filter(Boolean)
    const hasNomic = names.some(
      (n) => n === 'nomic-embed-text' || n.startsWith('nomic-embed-text:')
    )
    if (!hasNomic) {
      return {
        ok: false,
        detail: `${OLLAMA_PROBE_URL} reachable but nomic-embed-text missing (models=${names.slice(0, 12).join(',') || 'none'})`
      }
    }
    const probe = createOllamaEmbedder({ baseUrl: OLLAMA_PROBE_URL })
    await probe.embed(['probe'])
    return { ok: true, detail: `${OLLAMA_PROBE_URL} + nomic-embed-text embed ok` }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { cause?: { code?: string } }
    const code = e.cause?.code ?? e.code ?? (err instanceof Error ? err.message : String(err))
    return { ok: false, detail: `${OLLAMA_PROBE_URL} probe failed: ${code}` }
  }
}

const ollamaLive = await probeOllamaNomicEmbed()
if (!ollamaLive.ok) {
  // Exact probe result — not a fake pass. CLI pull skipped (ollama not on PATH / unreachable).
  console.warn(
    `[codeindex] Ollama live neural golden SKIPPED — ${ollamaLive.detail}. No ollama CLI pull attempted.`
  )
}

describe('codeindex Ollama live neural golden', () => {
  let dir: string

  afterEach(() => {
    if (dir) {
      closeCodeIndex(dir)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function seedFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-ollama-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      `export function validateAuthToken(token: string): boolean {
  if (!token) return false
  return token.startsWith('Bearer ')
}

export function hashPassword(password: string): string {
  return password.split('').reverse().join('')
}
`,
      'utf8'
    )
    writeFileSync(
      join(root, 'src', 'billing.ts'),
      `export function processRefund(orderId: string): void {
  const amount = 10
  console.log('refund', orderId, amount)
}

export function calculateTax(cents: number): number {
  return Math.round(cents * 0.1)
}
`,
      'utf8'
    )
    return root
  }

  it.skipIf(!ollamaLive.ok)(
    'golden: neural conceptual NL beats hash-only baseline',
    async () => {
      dir = seedFixture()
      // Conceptual query: few shared surface tokens with auth.ts (forces embedding quality).
      const query = 'where is the credential gate for incoming API requests'

      const hashEmbedder = createLocalHashEmbedder()
      const hashStore = CodeIndexStore.open(dir, hashEmbedder.dimensions)
      let hashAuthRank = -1
      try {
        await syncCodeIndex(dir, hashStore, hashEmbedder)
        const hashHits = await searchCodeIndex(dir, hashStore, hashEmbedder, query, {
          mode: 'semantic',
          limit: 8
        })
        hashAuthRank = hashHits.findIndex((h) => h.path.includes('auth'))
      } finally {
        hashStore.close()
      }

      closeCodeIndex(dir)
      const neuralEmbedder = createOllamaEmbedder({ baseUrl: OLLAMA_PROBE_URL })
      const neuralStore = CodeIndexStore.open(dir, neuralEmbedder.dimensions)
      try {
        await syncCodeIndex(dir, neuralStore, neuralEmbedder)
        const neuralHits = await searchCodeIndex(dir, neuralStore, neuralEmbedder, query, {
          mode: 'semantic',
          limit: 8
        })
        const neuralAuthRank = neuralHits.findIndex((h) => h.path.includes('auth'))
        expect(neuralAuthRank).toBeGreaterThanOrEqual(0)
        // Neural must beat hash: find auth when hash misses, or rank strictly better.
        expect(hashAuthRank < 0 || neuralAuthRank < hashAuthRank).toBe(true)
      } finally {
        neuralStore.close()
      }

      const out = await toolCodebaseSearch(dir, query, {
        preferOllama: true,
        maxResults: 8,
        mode: 'hybrid',
        refresh: true
      })
      expect(out).toMatch(/model=ollama:/)
      expect(out).not.toMatch(/fallback=hash/)
      expect(out.toLowerCase()).toMatch(/auth|validate|bearer|credential/)
    }
  )
})
