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
export function createOllamaEmbedder(opts: OllamaEmbedOptions = {}): Embedder {
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
  const model = opts.model ?? 'nomic-embed-text'
  const dimensions = opts.dimensions ?? 768
  const fetchImpl = opts.fetchImpl ?? fetch
  const modelId = `ollama:${model}`

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
    if (!Array.isArray(json.embedding)) {
      throw new Error('Ollama embeddings response missing embedding[]')
    }
    return l2NormalizeVec(json.embedding, dimensions)
  }

  return {
    modelId,
    dimensions,
    async embed(
      texts: string[],
      embedOpts?: { signal?: AbortSignal }
    ): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      if (embedOpts?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      try {
        const res = await fetchImpl(`${baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
          signal: embedOpts?.signal
        })
        if (res.ok) {
          const json = (await res.json()) as { embeddings?: number[][] }
          if (Array.isArray(json.embeddings) && json.embeddings.length === texts.length) {
            return json.embeddings.map((row) => l2NormalizeVec(row, dimensions))
          }
        }
      } catch (err) {
        if (isAbortError(err) || embedOpts?.signal?.aborted) {
          throw err instanceof DOMException ? err : new DOMException('Aborted', 'AbortError')
        }
        // Fall through to per-prompt /api/embeddings.
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

