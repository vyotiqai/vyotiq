import { z } from 'zod'

export const SkinIdSchema = z.enum(['default', 'proof', 'bench', 'native'])
export type SkinId = z.infer<typeof SkinIdSchema>

export const SKIN_IDS: readonly SkinId[] = ['default', 'proof', 'bench', 'native']

export const DEFAULT_SKIN_ID: SkinId = 'default'

export type SkinCatalogEntry = {
  id: SkinId
  label: string
  description: string
  /** Inline preview for the settings swatch chip. */
  previewStyle: Record<string, string>
}

export const SKIN_CATALOG: readonly SkinCatalogEntry[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Shipped instrument look.',
    previewStyle: {
      background: 'linear-gradient(135deg, #fafafa 50%, #e5e5e5 50%)'
    }
  },
  {
    id: 'proof',
    label: 'Proof',
    description: 'Sharper contrast for diffs and long reading.',
    previewStyle: {
      background: 'linear-gradient(135deg, #ffffff 50%, #525252 50%)'
    }
  },
  {
    id: 'bench',
    label: 'Bench',
    description: 'Flat workshop — borders only, no elevation.',
    previewStyle: {
      background: 'linear-gradient(135deg, #fafafa 50%, #d4d4d4 50%)'
    }
  },
  {
    id: 'native',
    label: 'Native',
    description: 'System UI fonts with default neutral palette.',
    previewStyle: {
      background: 'linear-gradient(135deg, #f5f5f5 50%, #d4d4d4 50%)',
      fontFamily: 'system-ui, sans-serif'
    }
  }
]

/** Opaque window canvas. */
export function resolveSkinWindowBackground(
  _skinId: SkinId,
  resolved: 'light' | 'dark',
  _platform?: string
): string {
  return resolved === 'dark' ? '#000000' : '#ffffff'
}
