import type { ImageOutputFormat } from './types'

export function mimeForOutputFormat(format: ImageOutputFormat | undefined): string {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'png':
    default:
      return 'image/png'
  }
}

export function extForMime(mimeType: string): string {
  const m = mimeType.toLowerCase().split(';')[0]?.trim() ?? ''
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg'
  if (m === 'image/webp') return '.webp'
  if (m === 'image/gif') return '.gif'
  if (m === 'image/svg+xml' || m === 'image/svg') return '.svg'
  return '.png'
}

export function normalizeOutputFormat(
  raw: string | undefined
): ImageOutputFormat | undefined {
  if (!raw) return undefined
  const v = raw.trim().toLowerCase()
  if (v === 'jpg' || v === 'jpeg') return 'jpeg'
  if (v === 'png' || v === 'webp' || v === 'svg') return v
  return undefined
}
