import type { APIRoute } from 'astro'
import { docsHref, orderedDocs } from '../lib/docs'
import { SITE_PRODUCT } from '../lib/site'

export const GET: APIRoute = async ({ site }) => {
  const entries = await orderedDocs()
  const origin = site ?? new URL('https://vyotiq.com')
  const product = SITE_PRODUCT
  const lines = [
    `# ${product} documentation`,
    '',
    `Product documentation for the ${product} coding workspace.`,
    '',
    ...entries.map(
      (entry) =>
        `- [${entry.data.title}](${new URL(docsHref(entry.id), origin).href}): ${entry.data.description}`
    ),
    ''
  ]
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })
}
