/**
 * Copy the landing identity assets and extract the same Mono provider marks
 * the desktop composer uses. Presentation boards
 * (filled lockup / stack / wordmark cards) stay in resources/branding — only
 * the purpose-built monochrome social card is copied as the Open Graph image.
 */
import { cp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const identity = path.join(root, 'resources', 'branding', 'precision-mono')
const destBrand = path.join(root, 'landing', 'public', 'brand')
const destProviders = path.join(root, 'landing', 'src', 'assets', 'providers')
const lobehub = path.join(root, 'node_modules', '@lobehub', 'icons', 'es')

/** Product provider id -> @lobehub/icons folder. Same named hosts as ProviderIdSchema minus custom.
 * `modal` has no @lobehub mark (verified absent in 5.15.0) — ships a raw letter-mark below. */
const providerLogos = [
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['gemini', 'Gemini'],
  ['ollama', 'Ollama'],
  ['deepseek', 'DeepSeek'],
  ['groq', 'Groq'],
  ['openrouter', 'OpenRouter'],
  ['xai', 'XAI'],
  ['modal', null],
  ['mistral', 'Mistral'],
  ['opencode', 'OpenCode']
]

/** Raw monochrome marks for providers that @lobehub/icons does not ship. */
const RAW_PROVIDER_SVGS = {
  modal: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" role="img" aria-hidden="true">
  <title>Modal</title>
  <path d="M4 20V4h3.4l4.6 7.1L16.6 4H20v16h-3.2v-9.3L12 16.2 7.2 10.7V20H4z"/>
</svg>
`
}

/** Transparent chrome assets + OG board. Do not copy filled presentation boards into UI paths. */
const identityCopies = [
  ['vyotiq-mark-black.svg', 'mark-black.svg'],
  ['vyotiq-mark-white.svg', 'mark-white.svg'],
  ['vyotiq-wordmark-black.svg', 'wordmark-black.svg'],
  ['vyotiq-wordmark-white.svg', 'wordmark-white.svg'],
  ['vyotiq-social-card.png', 'og.png']
]

async function copyRequired(src, dest) {
  if (!existsSync(src)) {
    throw new Error(`[sync-landing-brand] missing source: ${path.relative(root, src)}`)
  }
  await cp(src, dest, { force: true })
}

/**
 * @param {string} source
 * @param {string} title
 */
function svgFromLobehubMono(source, title) {
  const viewBox = source.match(/viewBox:\s*"([^"]+)"/)?.[1]
  const fillRule = source.match(/fillRule:\s*"([^"]+)"/)?.[1] ?? 'evenodd'
  const paths = [...source.matchAll(/\bd:\s*"((?:\\.|[^"\\])*)"/g)].map((match) => match[1])
  if (viewBox == null || paths.length === 0) {
    throw new Error(`could not extract SVG paths for ${title}`)
  }
  const pathEls = paths.map((d) => `  <path d="${d}"/>`).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="currentColor" fill-rule="${fillRule}" role="img" aria-hidden="true">
  <title>${title}</title>
${pathEls}
</svg>
`
}

async function writeProviderLogo(id, folder) {
  if (folder == null) {
    const raw = RAW_PROVIDER_SVGS[id]
    if (!raw) throw new Error(`[sync-landing-brand] no raw provider mark for ${id}`)
    await writeFile(path.join(destProviders, `${id}.svg`), raw, 'utf8')
    return
  }
  const monoFile = path.join(lobehub, folder, 'components', 'Mono.js')
  if (!existsSync(monoFile)) {
    throw new Error(`[sync-landing-brand] missing provider mark: ${path.relative(root, monoFile)}`)
  }
  const source = await readFile(monoFile, 'utf8')
  const styleFile = path.join(lobehub, folder, 'style.js')
  const style = existsSync(styleFile) ? await readFile(styleFile, 'utf8') : ''
  const title = style.match(/export var TITLE = '([^']+)'/)?.[1] ?? folder
  await writeFile(path.join(destProviders, `${id}.svg`), svgFromLobehubMono(source, title), 'utf8')
}

async function sync() {
  await mkdir(destBrand, { recursive: true })
  await mkdir(destProviders, { recursive: true })

  for (const [from, to] of identityCopies) {
    await copyRequired(path.join(identity, from), path.join(destBrand, to))
  }

  for (const [id, folder] of providerLogos) {
    await writeProviderLogo(id, folder)
  }

  await copyRequired(path.join(root, 'resources', 'icon.png'), path.join(destBrand, 'favicon.png'))

  const brandKeep = new Set([...identityCopies.map(([, to]) => to), 'favicon.png'])
  for (const name of await readdir(destBrand)) {
    if (!brandKeep.has(name)) await unlink(path.join(destBrand, name))
  }

  const providerKeep = new Set(providerLogos.map(([id]) => `${id}.svg`))
  for (const name of await readdir(destProviders)) {
    if (!providerKeep.has(name)) await unlink(path.join(destProviders, name))
  }

  console.log(
    `[sync-landing-brand] synced ${identityCopies.length + providerLogos.length + 2} files`
  )
}

sync().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
