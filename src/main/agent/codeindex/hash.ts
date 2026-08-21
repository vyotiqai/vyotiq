import { createHash } from 'crypto'

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Chunk cache key: model + path + line range + body. */
export function chunkContentHash(
  modelId: string,
  path: string,
  startLine: number,
  endLine: number,
  text: string
): string {
  return sha256Text(`${modelId}\n${path}\n${startLine}:${endLine}\n${text}`)
}
