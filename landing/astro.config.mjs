import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

const site = process.env.PUBLIC_SITE_URL || 'https://vyotiq.com'

export default defineConfig({
  site,
  output: 'static',
  compressHTML: true,
  integrations: [sitemap()],
  redirects: {
    '/products/agent-v': '/',
    '/docs/start': '/docs/start/quickstart',
    '/docs/guides/modes': '/docs/agent/modes',
    '/docs/guides/providers': '/docs/customize/providers',
    '/docs/guides/marketplace': '/docs/customize/marketplace',
    '/docs/guides/memory-and-search': '/docs/tools/memory',
    '/docs/guides/checkpoints': '/docs/agent/checkpoints',
    '/docs/guides/approval-browser-terminal': '/docs/tools/browser',
    '/docs/guides/git': '/docs/tools/changes-git',
    '/docs/concepts/context': '/docs/agent/context-compaction',
    '/docs/reference/slash-commands': '/docs/customize/slash-commands'
  },
  vite: {
    plugins: [tailwindcss()]
  }
})
