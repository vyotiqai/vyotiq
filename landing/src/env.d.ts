/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SITE_URL?: string
  readonly PUBLIC_ANALYTICS_SRC?: string
  readonly PUBLIC_ANALYTICS_DOMAIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
