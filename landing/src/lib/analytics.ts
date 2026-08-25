export type LandingAnalytics = {
  src: string
  domain: string
}

/** Cookieless analytics only when both public env vars are set and valid. */
export function landingAnalytics(): LandingAnalytics | null {
  const src = import.meta.env.PUBLIC_ANALYTICS_SRC?.trim() ?? ''
  const domain = import.meta.env.PUBLIC_ANALYTICS_DOMAIN?.trim() ?? ''
  if (!src || !domain) return null
  if (!/^[a-z0-9.-]+$/i.test(domain)) return null
  try {
    const url = new URL(src)
    if (url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return { src: url.href, domain }
  } catch {
    return null
  }
}
