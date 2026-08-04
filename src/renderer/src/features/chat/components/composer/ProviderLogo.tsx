import { cn } from '@renderer/lib/ui/cn'
import type { ProviderId } from '@shared/ipc'
import {
  PROVIDER_BRAND_DATA,
  resolveProviderBrandSlug,
  type ProviderBrandSlug
} from './providerBrandPaths'

export type ProviderLogoId = ProviderId | string

const SIZE = { sm: 16, md: 20, lg: 24 } as const

function BrandMark({
  slug,
  size,
  className
}: {
  slug: ProviderBrandSlug
  size: number
  className?: string
}) {
  const brand = PROVIDER_BRAND_DATA[slug]
  return (
    <brand.Component
      size={size}
      style={{ color: brand.colorPrimary }}
      className={cn('shrink-0', className)}
      aria-hidden="true"
    />
  )
}

function GenericIcon({
  size,
  className,
  letter
}: {
  size: number
  className?: string
  letter: string
}) {
  const initial = letter.slice(0, 1).toUpperCase()
  const hue = [...initial].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360
  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-sm font-semibold',
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size - 6),
        backgroundColor: `hsl(${hue} 70% 50% / 0.15)`,
        color: `hsl(${hue} 70% 55%)`
      }}
      aria-hidden
    >
      {initial}
    </span>
  )
}

export function ProviderLogo({
  id,
  subProvider,
  size = 'md',
  className
}: {
  id: ProviderLogoId
  subProvider?: string
  size?: keyof typeof SIZE
  className?: string
}) {
  const px = SIZE[size]
  const subSlug = subProvider ? resolveProviderBrandSlug(subProvider) : undefined
  const providerSlug = resolveProviderBrandSlug(String(id))
  const slug = subSlug ?? providerSlug

  if (slug) {
    return <BrandMark slug={slug} size={px} className={className} />
  }

  const fallbackKey = (subProvider ?? String(id)).toLowerCase()
  return <GenericIcon size={px} className={className} letter={fallbackKey.slice(0, 1)} />
}
