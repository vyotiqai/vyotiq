import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { BUILTIN_TOOL_NAMES } from '@main/agent/schemas/tools'
import { BUILTIN_COMMANDS } from '@main/agent/slashCommands/builtins'
import {
  isProviderConfigured,
  listConfiguredProviders,
  PROVIDER_DEFAULTS
} from '@shared/providers'
import {
  DEFAULT_SETTINGS,
  emptySecretStatus,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_CHARS,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES
} from '@shared/ipc'
import {
  DICTATION_ENGINE_OPTIONS,
  SECTION_LABELS
} from '@renderer/features/settings/constants'
import { MAX_FILES } from '@renderer/features/chat/components/composer/useComposerFiles'
import { MAX_IMAGES } from '@renderer/features/chat/components/composer/useComposerImages'
import { MAX_AUDIO_FILES } from '@renderer/features/chat/components/composer/useComposerAudio'

const REPO = process.cwd()
const ROOT = join(REPO, 'landing', 'src', 'content', 'docs')
const DOCS_INDEX = join(REPO, 'landing', 'src', 'pages', 'docs', 'index.astro')
const LANDING_SOURCE = join(REPO, 'landing', 'src')
const HOMEPAGE_COMPONENTS = [
  'pages/index.astro',
  'components/Hero.astro',
  'components/FeatureGrid.astro',
  'components/ProviderMarks.astro',
  'components/SiteHeader.astro',
  'components/SiteFooter.astro'
] as const

const SECTION_COUNTS = {
  start: 3,
  agent: 8,
  customize: 8,
  tools: 9,
  concepts: 4,
  reference: 6,
  troubleshooting: 6
} as const

const REQUIRED_WORKFLOWS = [
  'start/install.md',
  'start/quickstart.md',
  'start/product-tour.md',
  'agent/modes.md',
  'agent/prompting-attachments.md',
  'agent/workspaces-sessions.md',
  'agent/background-runs.md',
  'agent/instances.md',
  'customize/providers.md',
  'customize/mcp.md',
  'customize/skills.md',
  'customize/rules.md',
  'customize/packages.md',
  'tools/files-editor.md',
  'tools/browser.md',
  'tools/terminal.md',
  'tools/pull-requests.md',
  'tools/voice-dictation.md',
  'tools/notifications.md',
  'concepts/privacy-data.md',
  'reference/attachments.md',
  'reference/storage.md',
  'troubleshooting/runs-network-recovery.md'
] as const

function readDoc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function collectMarkdown(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${name.name}` : name.name
    if (name.isDirectory()) {
      out.push(...collectMarkdown(join(dir, name.name), rel))
    } else if (name.name.endsWith('.md')) {
      out.push(rel.replace(/\\/g, '/'))
    }
  }
  return out
}

function frontmatter(text: string): string {
  return text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
}

function scalar(text: string, key: string): string {
  const value = frontmatter(text).match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? ''
  return value.replace(/^['"]|['"]$/g, '')
}

function list(text: string, key: string): string[] {
  const block = frontmatter(text).match(new RegExp(`^${key}:\\s*\\r?\\n((?:  - .+\\r?\\n?)+)`, 'm'))?.[1]
  if (!block) return []
  return block
    .split(/\r?\n/)
    .map((line) => line.match(/^ {2}- (.+)$/)?.[1]?.trim() ?? '')
    .filter(Boolean)
}

function docsId(rel: string): string {
  return rel.replace(/\.md$/, '')
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16)
  ]
}

function relativeLuminance(hex: string): number {
  const channels = hexToRgb(hex).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b))
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b))
  return (lighter + 0.05) / (darker + 0.05)
}

function themeTokens(css: string, selector: RegExp): Record<string, string> {
  const block = css.match(selector)?.[1] ?? ''
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1]!, match[2]!])
  )
}

describe('landing docs architecture and truth', () => {
  const files = collectMarkdown(ROOT).sort()
  const ids = new Set(files.map(docsId))
  const canonicalRoutes = ['/docs', ...files.map((file) => `/docs/${docsId(file)}`)]

  it('ships all 45 canonical docs routes with unique section ordering', () => {
    expect(existsSync(DOCS_INDEX)).toBe(true)
    expect(files).toHaveLength(44)
    expect(canonicalRoutes).toHaveLength(45)
    expect(new Set(canonicalRoutes).size).toBe(45)
    expect(canonicalRoutes).toContain('/docs')
    expect(canonicalRoutes).toContain('/docs/start/quickstart')
    for (const [section, count] of Object.entries(SECTION_COUNTS)) {
      const sectionFiles = files.filter((file) => file.startsWith(`${section}/`))
      expect(sectionFiles).toHaveLength(count)
      const orders = sectionFiles.map((file) => Number(scalar(readDoc(file), 'order')))
      expect(new Set(orders).size, `${section} duplicate order`).toBe(orders.length)
      expect([...orders].sort((a, b) => a - b), `${section} contiguous order`).toEqual(
        Array.from({ length: count }, (_, index) => index + 1)
      )
    }
    for (const page of REQUIRED_WORKFLOWS) expect(files).toContain(page)
  })

  it('requires unique production metadata and source ownership on every page', () => {
    const titles = new Set<string>()
    const descriptions = new Set<string>()
    for (const file of files) {
      const text = readDoc(file)
      const title = scalar(text, 'title')
      const description = scalar(text, 'description')
      expect(title, `${file} title`).not.toBe('')
      expect(description, `${file} description`).not.toBe('')
      expect(titles.has(title), `duplicate title ${title}`).toBe(false)
      expect(descriptions.has(description), `duplicate description ${description}`).toBe(false)
      titles.add(title)
      descriptions.add(description)
      expect(Object.keys(SECTION_COUNTS), `${file} section`).toContain(scalar(text, 'section'))
      expect(['quickstart', 'guide', 'concept', 'reference', 'troubleshooting']).toContain(
        scalar(text, 'type')
      )
      expect(scalar(text, 'audience'), `${file} audience`).not.toBe('')
      expect(scalar(text, 'owner'), `${file} owner`).not.toBe('')
      expect(scalar(text, 'lastVerified'), `${file} lastVerified`).toMatch(/^\d+\.\d+\.\d+$/)
      expect(list(text, 'sources').length, `${file} sources`).toBeGreaterThan(0)
      expect(text, `${file} placeholder`).not.toMatch(/\bTODO\s*:|\bTBD\b|\bComing soon\b/i)
      expect((text.match(/^## /gm) ?? []).length, `${file} content depth`).toBeGreaterThanOrEqual(2)
    }
  })

  it('keeps every declared product source and related page resolvable', () => {
    const missing: string[] = []
    for (const file of files) {
      const text = readDoc(file)
      for (const source of list(text, 'sources')) {
        if (!existsSync(join(REPO, source))) missing.push(`${file}: source ${source}`)
      }
      for (const related of list(text, 'related')) {
        if (!ids.has(related)) missing.push(`${file}: related ${related}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('keeps internal documentation links valid', () => {
    for (const file of files) {
      const text = readDoc(file)
      for (const match of text.matchAll(/\]\(\/docs(?:\/([^#)\s]+))?(?:#[^)\s]+)?\)/g)) {
        if (!match[1]) continue
        expect(ids.has(match[1]), `${file} broken /docs/${match[1]}`).toBe(true)
      }
    }
  })

  it('indexes real titles, summaries, and markdown content with wired controls', () => {
    const library = readFileSync(join(REPO, 'landing', 'src', 'lib', 'docs.ts'), 'utf8')
    const layout = readFileSync(join(REPO, 'landing', 'src', 'layouts', 'DocsLayout.astro'), 'utf8')
    expect(library).toContain('title: entry.data.title')
    expect(library).toContain('description: entry.data.description')
    expect(library).toContain('searchableMarkdown(entry.body)')
    expect(layout).toContain('data-docs-search-open')
    expect(layout).toContain('data-docs-search-input')
    expect(layout).toContain('event.key.toLowerCase()')
    expect(layout).toContain('data-docs-copy')
    expect(layout).toContain('aria-current')
    expect(layout).toContain('rel="prev"')
    expect(layout).toContain('rel="next"')
  })

  it('sets docs chrome aria-current only on the docs index', () => {
    const header = readFileSync(join(LANDING_SOURCE, 'components', 'SiteHeader.astro'), 'utf8')
    const footer = readFileSync(join(LANDING_SOURCE, 'components', 'SiteFooter.astro'), 'utf8')
    expect(header).toContain(
      "const onDocsIndex = Astro.url.pathname === '/docs' || Astro.url.pathname === '/docs/'"
    )
    expect(footer).toContain(
      "const onDocsIndex = Astro.url.pathname === '/docs' || Astro.url.pathname === '/docs/'"
    )
    expect(header).toContain("aria-current={onDocsIndex ? 'page' : undefined}")
    expect(footer).toContain("aria-current={onDocsIndex ? 'page' : undefined}")
    expect(header).not.toContain("aria-current={onDocs ? 'page' : undefined}")
    expect(footer).not.toContain("aria-current={onDocs ? 'page' : undefined}")
  })

  it('lists all 59 built-ins including Skill', () => {
    const tools = readDoc('reference/tools.md')
    expect(BUILTIN_TOOL_NAMES).toHaveLength(59)
    for (const name of BUILTIN_TOOL_NAMES) {
      expect(tools, `missing tool ${name}`).toContain(`\`${name}\``)
    }
    expect(tools).toContain('`Skill`')
    expect(tools).not.toMatch(/\b43 tools\b/i)
  })

  it('lists every built-in slash command and the exact marketplace description', () => {
    const slash = readDoc('customize/slash-commands.md')
    expect(BUILTIN_COMMANDS).toHaveLength(13)
    for (const command of BUILTIN_COMMANDS) {
      expect(slash, `missing /${command.trigger}`).toContain(`/${command.trigger}`)
    }
    const marketplace = BUILTIN_COMMANDS.find((command) => command.trigger === 'marketplace')
    expect(marketplace).toBeDefined()
    expect(marketplace!.description).toMatch(/packages/)
    expect(marketplace!.description).not.toMatch(/plugin/i)
    expect(slash).toContain(marketplace!.description)
    expect(slash).not.toMatch(/\bplugins?\b/i)
  })

  it('documents the initial active selection without inventing a Default label', () => {
    const providers = readDoc('customize/providers.md')
    const quickstart = readDoc('start/quickstart.md')
    const features = readFileSync(
      join(LANDING_SOURCE, 'components', 'FeatureGrid.astro'),
      'utf8'
    )
    const secrets = emptySecretStatus()
    expect(PROVIDER_DEFAULTS).toHaveLength(10)
    for (const entry of PROVIDER_DEFAULTS) {
      expect(providers, `missing provider ${entry.id}`).toContain(`\`${entry.id}\``)
    }
    expect(DEFAULT_SETTINGS.provider).toBe('ollama')
    expect(DEFAULT_SETTINGS.model).toBe('qwen2.5')
    expect(
      isProviderConfigured('ollama', secrets, {
        ollamaBaseUrl: DEFAULT_SETTINGS.ollamaBaseUrl
      })
    ).toBe(true)
    expect(
      listConfiguredProviders(secrets, {
        ollamaBaseUrl: DEFAULT_SETTINGS.ollamaBaseUrl,
        customOpenAiBaseUrl: DEFAULT_SETTINGS.customOpenAiBaseUrl,
        alwaysInclude: [DEFAULT_SETTINGS.provider]
      })
    ).toContain('ollama')
    for (const text of [providers, quickstart]) {
      expect(text).toContain('`qwen2.5`')
      expect(text).toContain('Ollama')
    }
    expect(providers).toContain('**Active provider** shows local Ollama')
    expect(features).toContain('New settings initially select Ollama with <code>qwen2.5</code>')
    expect(features).toContain('eight named cloud providers')
    expect(features).toContain('custom OpenAI-compatible host')
    expect(features).not.toMatch(/default provider/i)
    expect(providers).not.toMatch(/default provider/i)
    for (const file of files) {
      expect(readDoc(file), `${file} unsupported empty-provider claim`).not.toMatch(
        /no default provider|no provider is selected/i
      )
    }
  })

  it('ships the eight-section homepage in the approved order with exact product labels', () => {
    const hero = readFileSync(join(LANDING_SOURCE, 'components', 'Hero.astro'), 'utf8')
    const features = readFileSync(
      join(LANDING_SOURCE, 'components', 'FeatureGrid.astro'),
      'utf8'
    )
    const page = readFileSync(join(LANDING_SOURCE, 'pages', 'index.astro'), 'utf8')
    expect(page).toContain('<Hero />')
    expect(page).toContain('<FeatureGrid />')

    expect(hero).toContain('id="overview"')
    expect(features).toContain('id="capabilities"')
    const sectionTitles = [
      'One place to understand, change, and review a repository.',
      'Choose how the agent works.',
      'Stay oriented as the task grows.',
      'Use the models you configure.',
      'Add context and capability on purpose.',
      'Local state, explicit network boundaries.',
      'Explore the product in detail.'
    ]
    let cursor = -1
    for (const title of sectionTitles) {
      const next = features.indexOf(title)
      expect(next, `${title} missing or out of order`).toBeGreaterThan(cursor)
      cursor = next
    }
    for (const label of ['Files', 'Browser', 'Terminal', 'Changes', 'Pull Request', 'Plan']) {
      expect(features, `missing panel ${label}`).toContain(`name: '${label}'`)
    }
    for (const mode of ['Ask', 'Plan', 'Agent']) {
      expect(features, `missing mode ${mode}`).toContain(`name: '${mode}'`)
    }
  })

  it('uses canonical brand assets, clean typography, and a concise hero', () => {
    const hero = readFileSync(join(LANDING_SOURCE, 'components', 'Hero.astro'), 'utf8')
    const providers = readFileSync(
      join(LANDING_SOURCE, 'components', 'ProviderMarks.astro'),
      'utf8'
    )
    const brand = readFileSync(join(LANDING_SOURCE, 'components', 'BrandLockup.astro'), 'utf8')
    const css = readFileSync(join(LANDING_SOURCE, 'styles', 'global.css'), 'utf8')
    const sync = readFileSync(join(REPO, 'scripts', 'sync-landing-brand.mjs'), 'utf8')
    const appProviderLogo = readFileSync(
      join(
        REPO,
        'src',
        'renderer',
        'src',
        'features',
        'chat',
        'components',
        'composer',
        'ProviderLogo.tsx'
      ),
      'utf8'
    )

    expect(hero.match(/<h1\b/g)).toHaveLength(1)
    expect(hero.match(/<p\b/g)).toHaveLength(2)
    expect(hero.match(/<a\b/g)).toHaveLength(2)
    expect(hero).toContain('home-eyebrow')
    expect(hero).toContain('{SITE_PRODUCT}')
    expect(hero).not.toContain('{SITE_BRAND} {SITE_PRODUCT}')
    expect(hero).not.toMatch(/<strong>|Desktop|Electron/)
    expect(css).toContain('--font-headline: "Plus Jakarta Sans", system-ui, sans-serif')
    expect(css).not.toMatch(/Unbounded|@font-face/)
    expect(sync).toContain("resources', 'branding', 'precision-mono")
    expect(sync).toContain("node_modules', '@lobehub', 'icons', 'es")
    expect(sync).not.toMatch(/destFonts|Unbounded-variable/)
    expect(brand).toContain('/brand/mark-black.svg')
    expect(brand).toContain('/brand/wordmark-black.svg')
    expect(brand).toContain('width="73"')
    expect(brand).toContain('height="13"')
    expect(brand).toContain('gap-2.5')
    expect(sync).toContain("'vyotiq-social-card.png', 'og.png'")
    for (const provider of [
      'openai',
      'anthropic',
      'gemini',
      'ollama',
      'deepseek',
      'groq',
      'openrouter',
      'xai',
      'mistral'
    ]) {
      expect(providers).toContain('PROVIDERS.map')
      expect(existsSync(join(LANDING_SOURCE, 'assets', 'providers', `${provider}.svg`))).toBe(true)
    }
    expect(providers).toContain('Custom host')
    expect(appProviderLogo).toContain('PlugsConnectedIcon')
  })

  it('names Agent V as the product beside the Vyotiq company mark', () => {
    const site = readFileSync(join(LANDING_SOURCE, 'lib', 'site.ts'), 'utf8')
    const layout = readFileSync(join(LANDING_SOURCE, 'layouts', 'BaseLayout.astro'), 'utf8')
    const docsLayout = readFileSync(join(LANDING_SOURCE, 'layouts', 'DocsLayout.astro'), 'utf8')
    const llms = readFileSync(join(LANDING_SOURCE, 'pages', 'llms.txt.ts'), 'utf8')
    const header = readFileSync(join(LANDING_SOURCE, 'components', 'SiteHeader.astro'), 'utf8')
    const footer = readFileSync(join(LANDING_SOURCE, 'components', 'SiteFooter.astro'), 'utf8')
    const hero = readFileSync(join(LANDING_SOURCE, 'components', 'Hero.astro'), 'utf8')
    const chatHero = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'features', 'chat', 'components', 'ChatHeroStage.tsx'),
      'utf8'
    )
    const emptyChat = readFileSync(
      join(
        REPO,
        'src',
        'renderer',
        'src',
        'features',
        'chat',
        'components',
        'ChatTranscriptStage.tsx'
      ),
      'utf8'
    )
    const about = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'features', 'settings', 'sections', 'AboutSection.tsx'),
      'utf8'
    )
    const builder = readFileSync(join(REPO, 'electron-builder.yml'), 'utf8')
    const appInfo = readFileSync(join(REPO, 'src', 'main', 'ipc', 'register.ts'), 'utf8')
    const pkg = readFileSync(join(REPO, 'package.json'), 'utf8')
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
    const landingReadme = readFileSync(join(REPO, 'landing', 'README.md'), 'utf8')
    const install = readDoc('start/install.md')
    const what = readDoc('concepts/what-it-is.md')
    const marketplace = readDoc('customize/marketplace.md')

    expect(site).toContain("export const SITE_BRAND = 'Vyotiq'")
    expect(site).toContain("export const SITE_PRODUCT = 'Agent V'")
    expect(site).toContain("'Agent V brings")
    expect(layout).toContain('`${SITE_PRODUCT} — ${SITE_TAGLINE}`')
    expect(layout).toContain('const siteName = SITE_PRODUCT')
    expect(docsLayout).toContain('`${title} — ${SITE_PRODUCT}`')
    expect(docsLayout).toContain('Agent V {lastVerified}')
    expect(docsLayout).not.toMatch(/<dd>Vyotiq \{lastVerified\}<\/dd>/)
    expect(llms).toContain('const product = SITE_PRODUCT')
    expect(llms).toContain('# ${product} documentation')

    expect(header).toContain('<BrandLockup />')
    expect(header).toContain('aria-label={`${SITE_PRODUCT} home`}')
    expect(footer).toContain('<span>© {year} {SITE_BRAND}</span>')
    expect(footer).toContain('<span>{SITE_PRODUCT}</span>')
    expect(hero).toContain('<p class="home-eyebrow">{SITE_PRODUCT}</p>')

    expect(chatHero).not.toContain('VyotiqLockup')
    expect(chatHero).not.toContain('data-hero-brand')
    expect(emptyChat).not.toContain('VyotiqLockup')
    expect(emptyChat).not.toContain('data-empty-brand')
    expect(about).toContain('<VyotiqLockup markSize={36} />')
    expect(about).toContain('Agent V. A product of Vyotiq.com.')

    expect(builder).toMatch(/^productName: Vyotiq$/m)
    expect(appInfo).toContain("name: 'Vyotiq'")
    expect(pkg).toContain('"description": "Agent V — coding workspace for real repositories"')

    expect(readme).toMatch(/^# Agent V/m)
    expect(readme).toContain('The built-in catalog has **59** tools')
    expect(readme).not.toMatch(/\b43 tools\b/i)
    expect(readme).not.toMatch(/docs\/architecture\.md/)
    expect(readme).toContain('**MCPs**')
    expect(readme).toContain('**Skills**')
    expect(readme).toContain('**Rules**')
    expect(readme).toContain('**Packages**')
    expect(landingReadme).toMatch(/^# Agent V site/m)
    expect(scalar(what, 'title')).toBe('What Agent V is')
    expect(what).toMatch(/^Agent V is a coding workspace/m)
    for (const label of ['**MCPs**', '**Skills**', '**Rules**', '**Packages**']) {
      expect(marketplace).toContain(label)
    }
    expect(install).toContain('https://github.com/vyotiqai/vyotiq-agent-v/releases/latest')
    expect(install).toContain('`pnpm pack:win`')
    expect(install).toContain('`pnpm pack:mac`')
    expect(install).toContain('`pnpm pack:linux`')
    expect(install).not.toMatch(/the Vyotiq download page/i)
    expect(install).not.toMatch(/\b43 tools\b/i)
    const docsIndex = readFileSync(DOCS_INDEX, 'utf8')
    expect(docsIndex).toContain('<strong>Install Agent V</strong>')
    expect(docsIndex).not.toMatch(/<strong>Install Vyotiq<\/strong>/)
    const features = readFileSync(join(LANDING_SOURCE, 'components', 'FeatureGrid.astro'), 'utf8')
    expect(features).toContain('Agent V keeps the state')
    expect(features).not.toMatch(/\bVyotiq keeps\b/)
    for (const text of [
      readme,
      landingReadme,
      site,
      hero,
      layout,
      llms,
      what,
      install,
      docsIndex,
      pkg,
      about,
      chatHero,
      emptyChat
    ]) {
      expect(text).not.toMatch(/\bopen[- ]source\b/i)
      expect(text).not.toMatch(/\$\s*0\b/)
      expect(text).not.toMatch(/\bdefault provider\b/i)
      expect(text).not.toMatch(/Vyotiq Agent V/)
    }
    expect(layout).not.toContain('`${SITE_BRAND} ${SITE_PRODUCT}')
    expect(docsLayout).not.toContain('`${title} — ${SITE_BRAND} ${SITE_PRODUCT}`')
    expect(llms).not.toContain('`${SITE_BRAND} ${SITE_PRODUCT}`')
    expect(header).not.toContain('`${SITE_BRAND} ${SITE_PRODUCT} home`')
    expect(hero).not.toContain('{SITE_BRAND} {SITE_PRODUCT}')
  })

  it('does not use company-only Vyotiq as the inner-docs product actor', () => {
    const packagedNamePages = new Set(['start/install.md', 'reference/storage.md'])

    function leftoverCompanyMark(body: string): string[] {
      const stripped = body
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/\.vyotiq\b/gi, ' ')
      return [...stripped.matchAll(/\bVyotiq\b/g)].map((match) => match[0])
    }

    for (const file of files) {
      const source = readDoc(file)
      expect(source, file).not.toMatch(/Vyotiq Agent V/)
      const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      const leftover = leftoverCompanyMark(body)
      if (packagedNamePages.has(file)) {
        expect(body, file).toMatch(/Agent V/)
        expect(leftover.length, file).toBeGreaterThan(0)
        continue
      }
      expect(leftover, file).toEqual([])
    }
  })

  it('does not use the runtime as user-facing product identity', () => {
    const productCopy = [
      readFileSync(join(REPO, 'README.md'), 'utf8').split('## Develop it')[0]!,
      readFileSync(join(REPO, 'package.json'), 'utf8'),
      readFileSync(join(LANDING_SOURCE, 'lib', 'site.ts'), 'utf8'),
      readFileSync(join(LANDING_SOURCE, 'components', 'Hero.astro'), 'utf8'),
      readFileSync(join(LANDING_SOURCE, 'pages', 'llms.txt.ts'), 'utf8'),
      readDoc('concepts/what-it-is.md')
    ].join('\n')
    expect(productCopy).not.toMatch(
      /\b(?:lean\s+)?Electron\s+desktop|\bdesktop\s+(?:coding\s+)?(?:agent|app|application|workspace)\b/i
    )

    const technicalDocs = files
      .map((file) => readDoc(file))
      .filter((text) => /\bElectron\b/.test(text))
    expect(technicalDocs.length).toBeGreaterThan(0)
    for (const text of technicalDocs) {
      expect(text).not.toMatch(/\bElectron\s+desktop|\bdesktop\s+Electron\b/i)
    }
  })

  it('keeps homepage claims qualified and removes obsolete release surfaces', () => {
    const source = HOMEPAGE_COMPONENTS.map((rel) =>
      readFileSync(join(LANDING_SOURCE, rel), 'utf8')
    ).join('\n')
    for (const [label, pattern] of [
      ['open source', /\bopen[- ]source\b/i],
      ['free pricing', /(?:\$\s*0|\bfree\b)/i],
      ['no telemetry', /\bno telemetry\b/i],
      ['no cloud', /\bno cloud\b/i],
      ['everything local', /\beverything stays local\b/i],
      ['public installer', /\b(?:public )?(?:installer|download)\b/i],
      ['default provider', /\bdefault provider\b/i],
      ['universal undo', /\b(?:undo|reverse) (?:everything|all)\b/i],
      ['universal compatibility', /\b(?:all|every|universal(?:ly)?) OpenAI-compatible\b/i],
      ['fake launch state', /\b(?:available now|launch(?:ed)?|coming soon|waitlist)\b/i],
      ['fake social proof', /\b(?:trusted by|developers love|customers)\b/i]
    ] as const) {
      expect(source, `unsupported homepage claim: ${label}`).not.toMatch(pattern)
    }

    expect(source).toContain('subject to approvals')
    expect(source).toContain('They are not Git commits')
    expect(source).toContain('cannot reverse')
    expect(source).toContain('estimate')
    expect(source).toContain('rotating logs')
    expect(source).toContain('opt-in')
    expect(source).toContain('operating-system secure storage')
    expect(source).toContain('optional domain allowlist')
    expect(source).toContain('.vyotiq/memory/')
    expect(source).toContain('separate from memory')

    for (const rel of [
      'components/DownloadSection.astro',
      'components/ProductFrame.astro',
      'lib/downloads.ts',
      'lib/release-assets.ts',
      'lib/platform.ts'
    ]) {
      expect(existsSync(join(LANDING_SOURCE, rel)), `${rel} should be removed`).toBe(false)
    }
    expect(existsSync(join(REPO, 'scripts', 'capture-landing-product.mjs'))).toBe(false)
    expect(readFileSync(join(REPO, 'package.json'), 'utf8')).not.toContain('capture:landing')
  })

  it('meets text and boundary contrast thresholds in both themes', () => {
    const css = readFileSync(join(LANDING_SOURCE, 'styles', 'global.css'), 'utf8')
    const light = themeTokens(css, /:root,\s*\[data-theme="light"\]\s*\{([^}]+)\}/)
    const dark = themeTokens(css, /\[data-theme="dark"\]\s*\{([^}]+)\}/)
    for (const [name, tokens] of Object.entries({ light, dark })) {
      expect(contrastRatio(tokens.muted!, tokens.bg!), `${name} muted on background`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(tokens.muted!, tokens.surface!), `${name} muted on surface`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(tokens.border!, tokens.bg!), `${name} border on background`).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(tokens.border!, tokens.surface!), `${name} border on surface`).toBeGreaterThanOrEqual(3)
    }
  })

  it('lists all ten Settings section titles', () => {
    const settings = readDoc('reference/settings.md')
    const titles = Object.values(SECTION_LABELS).map((section) => section.title)
    expect(titles).toHaveLength(10)
    for (const title of titles) expect(settings, `missing ${title}`).toContain(`## ${title}`)
  })

  it('preserves dictation engines and attachment limits from product constants', () => {
    const voice = readDoc('tools/voice-dictation.md')
    const attachments = readDoc('reference/attachments.md')
    for (const engine of DICTATION_ENGINE_OPTIONS) expect(voice).toContain(`**${engine.label}**`)
    expect(attachments).toContain(`| Extracted file | ${MAX_FILES} |`)
    expect(attachments).toContain(`| Image | ${MAX_IMAGES} |`)
    expect(attachments).toContain(`| Audio | ${MAX_AUDIO_FILES} |`)
    expect(attachments).toContain(`${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`)
    expect(attachments).toContain(`${MAX_IMAGE_BYTES / (1024 * 1024)} MB`)
    expect(attachments).toContain(`${MAX_AUDIO_BYTES / (1024 * 1024)} MB`)
    expect(attachments).toContain(MAX_ATTACHMENT_CHARS.toLocaleString('en-US'))
  })

  it('keeps approval dialog labels distinct from Settings labels', () => {
    const quickstart = readDoc('start/quickstart.md')
    for (const label of [
      '**Mutating tools**',
      '**All tools**',
      '**Not now**',
      '**Ask for edits and commands**',
      '**Ask for every tool**'
    ]) {
      expect(quickstart).toContain(label)
    }
  })

  it('uses exact Marketplace Manage labels and Packages terminology', () => {
    const marketplace = readDoc('customize/marketplace.md')
    const what = readDoc('concepts/what-it-is.md')
    const packages = readDoc('customize/packages.md')
    for (const label of ['**MCPs**', '**Skills**', '**Rules**', '**Packages**']) {
      expect(marketplace).toContain(label)
    }
    const features = readFileSync(
      join(REPO, 'landing', 'src', 'components', 'FeatureGrid.astro'),
      'utf8'
    )
    const view = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'features', 'marketplace', 'MarketplaceView.tsx'),
      'utf8'
    )
    const home = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'features', 'marketplace', 'MarketplaceHome.tsx'),
      'utf8'
    )
    const labels = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'features', 'marketplace', 'marketplaceLabels.ts'),
      'utf8'
    )
    const installed = readFileSync(
      join(
        REPO,
        'src',
        'renderer',
        'src',
        'features',
        'marketplace',
        'MarketplaceInstalledList.tsx'
      ),
      'utf8'
    )
    expect(features).toMatch(/packages/i)
    expect(features).not.toMatch(/plugin/i)
    expect(view).toContain('MCP servers, skills, and packages for the agent.')
    expect(home).toContain('Search packages, skills, MCPs…')
    expect(home).toContain('<option value="plugin">Packages</option>')
    expect(home).not.toMatch(/>Plugins</)
    expect(labels).toContain("return 'Package'")
    expect(labels).not.toMatch(/return 'Plugin'/)
    expect(installed).toContain('MCP servers, skills, or packages.')
    expect(installed).toContain('Package MCP servers')
    expect(installed).not.toMatch(/or plugins/)
    for (const text of [marketplace, what, packages]) {
      expect(text).not.toMatch(/\bplugins?\b/i)
    }
  })
})
