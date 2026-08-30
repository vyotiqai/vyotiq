import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node-llama-cpp', () => ({
  getLlama: vi.fn().mockRejectedValue(new Error('node-llama-cpp mocked unavailable in unit tests')),
  resolveModelFile: vi.fn()
}))

// Force the in-process paths (real syncCodeIndex/searchCodeIndex over real SQLite).
vi.mock('@main/agent/codeindex/embedUtilityClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/codeindex/embedUtilityClient')>()
  return {
    ...actual,
    canUseIndexSearchUtility: () => false,
    canUseIndexSyncUtility: () => false
  }
})

// Deterministic nomic-shaped embedder served through the global fetch stub.
const NOMIC_DIM = 16
function tokenVector(text: string): number[] {
  const vec = new Array<number>(NOMIC_DIM).fill(0)
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const token of tokens) {
    let h = 2166136261
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    vec[Math.abs(h) % NOMIC_DIM] += 1
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => v / norm)
}

const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input)
  const body = JSON.parse(
    (typeof (input as Request).text === 'function' ? '' : '') || '{}'
  ) as never
  void body
  // Body is read from the init captured below instead — see stubFetch below.
  throw new Error(`unreachable: ${url}`)
})

// Wrap fetchMock so request bodies are visible to the responder.
let lastBodies: string[] = []
function stubFetch(): void {
  lastBodies = []
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? init.body : ''
    lastBodies.push(body)
    if (url.endsWith('/api/embed')) {
      const parsed = JSON.parse(body || '{}') as { input?: string[] }
      const rows = (parsed.input ?? []).map((t) => tokenVector(t))
      return new Response(JSON.stringify({ embeddings: rows }), { status: 200 })
    }
    if (url.endsWith('/api/embeddings')) {
      const parsed = JSON.parse(body || '{}') as { prompt?: string }
      return new Response(JSON.stringify({ embedding: tokenVector(parsed.prompt ?? '') }), {
        status: 200
      })
    }
    return new Response('not found', { status: 404 })
  })
}

const {
  runCodebaseSearch,
  closeCodeIndex,
  disposeCodeIndexWorkspace,
  CodeIndexStore,
  clearEmbedderFailCacheForTests,
  createLocalHashEmbedder,
  syncCodeIndex
} = await import('@main/agent/codeindex')
const { toolCodebaseSearch } = await import('@main/agent/tools/codebaseSearch')
import { setWorkspaceIndexStorageRootOverrideForTests } from '@main/agent/indexStoragePaths'
import {
  resetIndexJobQueueForTests
} from '@main/agent/indexJobQueue'
import {
  clearWorkspaceIndexSyncTimers,
  disposeWorkspaceIndexes
} from '@main/agent/workspaceIndex'
import { resetCodeIndexRuntimeStatusForTests } from '@main/agent/codeindex/modelStatus'

describe('codebase_search self-heals a mismatched index', () => {
  let dir: string | undefined
  let storageRoot: string | undefined

  function seedFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-selfheal-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      `export function validateAuthToken(token: string): boolean {
  if (!token) return false
  return token.startsWith('Bearer ')
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
`,
      'utf8'
    )
    return root
  }

  beforeEach(() => {
    stubFetch()
    storageRoot = mkdtempSync(join(tmpdir(), 'vyotiq-selfheal-storage-'))
    setWorkspaceIndexStorageRootOverrideForTests(storageRoot)
    clearEmbedderFailCacheForTests()
    resetCodeIndexRuntimeStatusForTests()
  })

  afterEach(() => {
    resetIndexJobQueueForTests()
    clearWorkspaceIndexSyncTimers()
    if (dir) {
      disposeWorkspaceIndexes(dir)
      disposeCodeIndexWorkspace(dir)
      closeCodeIndex(dir)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      dir = undefined
    }
    setWorkspaceIndexStorageRootOverrideForTests(null)
    if (storageRoot) {
      try {
        rmSync(storageRoot, { recursive: true, force: true })
      } catch {
        /* windows sqlite */
      }
      storageRoot = undefined
    }
    clearEmbedderFailCacheForTests()
    resetCodeIndexRuntimeStatusForTests()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('re-syncs a stored-hash index to the configured neural embedder and returns semantic hits', async () => {
    dir = seedFixture()
    // Phase 1 — a real hash index with real chunks (the "indexed under an old
    // embedder" state users hit after changing Settings → Indexing).
    const hashEmbedder = createLocalHashEmbedder(NOMIC_DIM)
    const store = CodeIndexStore.open(dir, hashEmbedder.dimensions)
    try {
      const sync = await syncCodeIndex(dir, store, hashEmbedder)
      expect(sync.indexed).toBeGreaterThan(0)
      expect(store.getStatus().chunkCount).toBeGreaterThan(0)
      expect(store.getStatus().modelId).toBe('local-hash-v1')
    } finally {
      store.close()
    }

    // Phase 2 — query embedder is the configured, NON-fallback neural one.
    const out = await runCodebaseSearch(dir, 'validateAuthToken', { embedderId: 'ollama' })

    // Self-heal: the store was re-embedded under the query embedder's model.
    expect(out.status.modelId).toBe('ollama:nomic-embed-text')
    expect(out.queryModelId).toBe('ollama:nomic-embed-text')
    expect(out.formatted).not.toMatch(/fallback=hash/)
    expect(out.formatted).not.toMatch(/lexical-only/)
    expect(out.formatted).not.toMatch(/does not match the indexed model/)
    expect(out.hits.length).toBeGreaterThan(0)
    expect(out.hits[0]?.path).toBe('src/auth.ts')
  })

  it('does NOT re-sync when the query embedder is a fallback (hash)', async () => {
    dir = seedFixture()
    const hashEmbedder = createLocalHashEmbedder(NOMIC_DIM)
    const store = CodeIndexStore.open(dir, hashEmbedder.dimensions)
    try {
      const sync = await syncCodeIndex(dir, store, hashEmbedder)
      expect(sync.indexed).toBeGreaterThan(0)
    } finally {
      store.close()
    }

    // Ollama unreachable → resolveEmbedder falls back to hash (usedFallback=true).
    fetchMock.mockImplementation(async () => new Response(' unreachable', { status: 503 }))

    // Assert through the real tool consumer (it owns the degradation note).
    const out = await toolCodebaseSearch(dir, 'validateAuthToken', { embedderId: 'ollama' })

    // Preserved: no destructive re-embed of a healthy store by a fallback.
    expect(out).toMatch(/model=local-hash-v1/)
    expect(out).toMatch(/fallback=hash/)
    expect(out).toMatch(/validateAuthToken/)
  })
})
