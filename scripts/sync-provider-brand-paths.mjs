/**
 * Regenerate providerBrandPaths.ts from @lobehub/icons mono components.
 * Run: pnpm sync:provider-icons
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const outFile = path.join(
  root,
  'src/renderer/src/features/chat/components/composer/providerBrandPaths.ts'
)

/** Product slug -> @lobehub/icons package folder name */
const BRANDS = [
  ['anthropic', 'Anthropic'],
  ['arcee', 'Arcee'],
  ['cohere', 'Cohere'],
  ['deepseek', 'DeepSeek'],
  ['gemini', 'Gemini'],
  ['google', 'Google'],
  ['groq', 'Groq'],
  ['meta', 'Meta'],
  ['microsoft', 'Microsoft'],
  ['mistral', 'Mistral'],
  ['nvidia', 'Nvidia'],
  ['ollama', 'Ollama'],
  ['openai', 'OpenAI'],
  ['openrouter', 'OpenRouter'],
  ['perplexity', 'Perplexity'],
  ['qwen', 'Qwen'],
  ['xai', 'XAI']
]

const ALIASES = {
  'meta-llama': 'meta',
  'x-ai': 'xai'
}

const importLines = [
  'import type { ComponentType, CSSProperties } from \'react\''
]
const dataEntries = []

for (const [slug, lobehub] of BRANDS) {
  const colorName = `${lobehub}Color`
  importLines.push(`import ${lobehub} from '@lobehub/icons/es/${lobehub}/components/Mono'`)
  importLines.push(
    `import { COLOR_PRIMARY as ${colorName} } from '@lobehub/icons/es/${lobehub}/style'`
  )
  dataEntries.push(`  ${slug}: { Component: ${lobehub}, colorPrimary: ${colorName} }`)
}

const aliasLines = Object.entries(ALIASES).map(([alias, slug]) => `  '${alias}': '${slug}'`)

const content = `${importLines.join('\n')}

export type ProviderBrandData = {
  Component: ComponentType<{
    size?: number | string
    style?: CSSProperties
    className?: string
  }>
  colorPrimary: string
}

export type ProviderBrandSlug = keyof typeof PROVIDER_BRAND_DATA

export const PROVIDER_BRAND_DATA = {
${dataEntries.join(',\n')}
} as const satisfies Record<string, ProviderBrandData>

export const PROVIDER_BRAND_ALIASES: Record<string, ProviderBrandSlug> = {
${aliasLines.join(',\n')}
}

export function resolveProviderBrandSlug(key: string): ProviderBrandSlug | undefined {
  const normalized = key.toLowerCase()
  if (normalized in PROVIDER_BRAND_DATA) return normalized as ProviderBrandSlug
  return PROVIDER_BRAND_ALIASES[normalized]
}
`

await writeFile(outFile, content, 'utf8')
console.log(
  `[sync-provider-brand-paths] wrote ${path.relative(root, outFile)} (${BRANDS.length} brands)`
)
