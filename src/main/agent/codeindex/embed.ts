import { DEFAULT_EMBED_DIM, DEFAULT_MODEL_ID } from './types'

export type EmbedRole = 'query' | 'document'

export type Embedder = {
  readonly modelId: string
  readonly dimensions: number
  embed(
    texts: string[],
    opts?: { role?: EmbedRole; signal?: AbortSignal }
  ): Promise<Float32Array[]>
}
/** Tokenize code/identifiers for local bag embeddings. */
export function tokenizeForEmbed(text: string): string[] {
  const out: string[] = []
  const re = /[A-Za-z_][A-Za-z0-9_]+|[a-z]+|[A-Z]+(?![a-z])/g
  let m: RegExpExecArray | null
  const lower = text
  while ((m = re.exec(lower)) !== null) {
    const tok = m[0]!
    out.push(tok.toLowerCase())
    // Split camelCase / snake remnants
    const parts = tok.split(/(?=[A-Z])|_/).filter(Boolean)
    for (const p of parts) {
      if (p.length > 1) out.push(p.toLowerCase())
    }
  }
  return out
}

function hashToken(token: string, dim: number): number {
  let h = 2166136261
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % dim
}

function embedOne(text: string, dim: number): Float32Array {
  const vec = new Float32Array(dim)
  const tokens = tokenizeForEmbed(text)
  if (!tokens.length) return vec
  for (const tok of tokens) {
    const i = hashToken(tok, dim)
    vec[i]! += 1
    // Signed random projection bit from token hash
    const sign = hashToken(tok + '#', 2) === 0 ? -1 : 1
    vec[i]! += 0.15 * sign
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) vec[i]! /= norm
  return vec
}

/** Deterministic local embedder (offline). Upgrade via Ollama embedder. */
export function createLocalHashEmbedder(
  dimensions = DEFAULT_EMBED_DIM,
  modelId = DEFAULT_MODEL_ID
): Embedder {
  return {
    modelId,
    dimensions,
    async embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<Float32Array[]> {
      const out: Float32Array[] = []
      for (const t of texts) {
        if (opts?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        out.push(embedOne(t, dimensions))
      }
      return out
    }
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!
  return dot
}

function l2NormalizeVec(src: ArrayLike<number>, dimensions: number): Float32Array {
  const vec = new Float32Array(dimensions)
  for (let i = 0; i < Math.min(dimensions, src.length); i++) {
    vec[i] = src[i]!
  }
  let norm = 0
  for (let i = 0; i < dimensions; i++) norm += vec[i]! * vec[i]!
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dimensions; i++) vec[i]! /= norm
  return vec
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  )
}

export type OllamaEmbedOptions = {
  baseUrl?: string
  model?: string
  dimensions?: number
  fetchImpl?: typeof fetch
}

/** Optional Ollama embeddings when a local server is running. */
/**
 * Auto-detect the Ollama model's true vector dimension on first embed, rather
 * than trusting an assumed 768. Without this, a 1024-dim model (mxbai-embed-large,
 * bge-m3, …) was silently truncated to 768, producing corrupt similarity scores.
 * When `dimensions` is configured explicitly we still validate the response matches.
 */
export function createOllamaEmbedder(opts: OllamaEmbedOptions = {}): Embedder {
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
  const model = opts.model ?? 'nomic-embed-text'
  const explicitDimensions = opts.dimensions
  const fetchImpl = opts.fetchImpl ?? fetch
  const modelId = `ollama:${model}`

  // configured (explicit) > auto-detected (observed) > default 768
  let observedDimensions: number | null = null

  /** Adopt or validate the response dimension; returns the canonical dimension. */
  function reconcileDimension(actual: number): number {
    if (actual <= 0) return observedDimensions ?? explicitDimensions ?? 768
    if (observedDimensions == null) {
      // First real observation: an explicit config that disagrees is a user error.
      if (explicitDimensions != null && explicitDimensions !== actual) {
        throw new Error(
          `Ollama model "${model}" produces ${actual}-dim vectors but codeIndex is configured ` +
            `for ${explicitDimensions}-dim. Set dimensions to ${actual} (or pick a matching model).`
        )
      }
      observedDimensions = actual
      return actual
    }
    if (observedDimensions !== actual) {
      throw new Error(
        `Ollama embedding dimension changed mid-session for "${model}": ` +
          `expected ${observedDimensions}, got ${actual}`
      )
    }
    return observedDimensions
  }

  async function embedOnePrompt(
    prompt: string,
    signal?: AbortSignal
  ): Promise<Float32Array> {
    const res = await fetchImpl(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt }),
      signal
    })
    if (!res.ok) {
      throw new Error(`Ollama embeddings failed: HTTP ${res.status}`)
    }
    const json = (await res.json()) as { embedding?: number[] }
    if (!Array.isArray(json.embedding) || json.embedding.length === 0) {
      throw new Error('Ollama embeddings response missing embedding[]')
    }
    const dim = reconcileDimension(json.embedding.length)
    return l2NormalizeVec(json.embedding, dim)
  }

  return {
    modelId,
    get dimensions(): number {
      return observedDimensions ?? explicitDimensions ?? 768
    },
    async embed(
      texts: string[],
      embedOpts?: { signal?: AbortSignal }
    ): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      if (embedOpts?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      // True once /api/embed returned a well-formed batch; a thrown error while
      // mapping such a batch (e.g. dimension mismatch) must propagate, not be
      // swallowed by the per-prompt fallback.
      let batchValid = false
      try {
        const res = await fetchImpl(`${baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
          signal: embedOpts?.signal
        })
        if (res.ok) {
          const json = (await res.json()) as { embeddings?: number[][] }
          const rows = json?.embeddings
          if (
            Array.isArray(rows) &&
            rows.length === texts.length &&
            rows.every((row) => Array.isArray(row) && row.length > 0)
          ) {
            batchValid = true
            return rows.map((row) => {
              const dim = reconcileDimension(row.length)
              return l2NormalizeVec(row, dim)
            })
          }
        }
      } catch (err) {
        if (isAbortError(err) || embedOpts?.signal?.aborted) {
          throw err instanceof DOMException ? err : new DOMException('Aborted', 'AbortError')
        }
        // Fall through to per-prompt /api/embeddings only when the batch itself
        // was unusable — never when a valid batch failed mid-processing.
        if (batchValid) throw err
      }
      const out: Float32Array[] = []
      for (const prompt of texts) {
        if (embedOpts?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        out.push(await embedOnePrompt(prompt, embedOpts?.signal))
      }
      return out
    }
  }
}

export function embeddingToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function bufferToEmbedding(buf: Buffer | Uint8Array, dimensions: number): Float32Array {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : Buffer.from(bytes)
  const floats = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.min(dimensions, Math.floor(aligned.byteLength / 4))
  )
  if (floats.length === dimensions) return floats
  const out = new Float32Array(dimensions)
  out.set(floats.subarray(0, Math.min(floats.length, dimensions)))
  return out
}

