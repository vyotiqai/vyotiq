/**
 * Generate plain-text siblings for Word-binary sources that runtime code and
 * tests read as files:
 *
 *   tests/fixtures/compact/(name).md.docx        -> (name).md
 *   landing/src/content/docs/(deep)(name).md.docx -> (name).md (structure kept)
 *   resources/marketplace/(deep)SKILL.md.docx     -> SKILL.md
 *
 * These directories still use .docx sources; canonical root documentation and
 * the system harness are plain Markdown and are intentionally excluded.
 * Runs on postinstall and before test/landing tasks. Idempotent — rewrites only
 * on content change.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { docxParagraphs } from './sync-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function walkDocx(dir, out = []) {
  let entries
    try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walkDocx(p, out)
    else if (entry.isFile() && entry.name.endsWith('.md.docx')) out.push(p)
  }
  return out
}

const SKILL_YAML_KEYS = [
  'name',
  'description',
  'license',
  'compatibility',
  'allowed-tools',
  'metadata',
  'version'
]

function headingLevel(style) {
  const match = String(style || '').match(/heading\s*(\d)/i)
  return match ? Number(match[1]) : 0
}

function looksLikeFlattenedSkillYaml(text) {
  return /^name:\s+\S+.+\bdescription:\s+/s.test(String(text || '').trim())
}

/** Rebuild multiline YAML from a Word-flattened `name: … description: …` line. */
function expandFlattenedSkillYaml(line) {
  const text = String(line || '').trim()
  const keyRe = new RegExp(
    `(?:^|\\s)(${SKILL_YAML_KEYS.map((key) => key.replace('-', '\\-')).join('|')}):`,
    'g'
  )
  const hits = []
  let match
  while ((match = keyRe.exec(text)) !== null) {
    const matched = match[0]
    hits.push({
      key: match[1],
      matchStart: match.index + (/^\s/.test(matched) ? 1 : 0),
      valueStart: match.index + matched.length
    })
  }
  if (hits.length < 2 || hits[0]?.key !== 'name' || hits[0].matchStart !== 0) return null
  if (!hits.some((hit) => hit.key === 'description')) return null

  const lines = []
  let sawMetadata = false
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index]
    const end = index + 1 < hits.length ? hits[index + 1].matchStart : text.length
    const value = text.slice(hit.valueStart, end).trim().replace(/^(?:>-?|\|-?)\s+/, '')
    if (hit.key === 'metadata') {
      if (!sawMetadata) {
        lines.push('metadata:')
        sawMetadata = true
      }
      continue
    }
    if (hit.key === 'version') {
      if (!sawMetadata) {
        lines.push('metadata:')
        sawMetadata = true
      }
      lines.push(`  version: ${value}`)
      continue
    }
    if (hit.key === 'description') {
      lines.push('description: >-', `  ${value}`)
      continue
    }
    lines.push(`${hit.key}: ${value}`)
  }
  return lines.join('\n')
}

function skillDocxToMarkdown(paragraphs) {
  const body = []
  let yaml = null
  for (const paragraph of paragraphs) {
    const text = paragraph.text?.trim() ?? ''
    if (!yaml && looksLikeFlattenedSkillYaml(text)) {
      yaml = expandFlattenedSkillYaml(text)
      continue
    }
    if (paragraph.border && !text) {
      body.push('---')
      continue
    }
    if (!text) continue
    const level = headingLevel(paragraph.style)
    if (level > 0 && !looksLikeFlattenedSkillYaml(text)) {
      body.push(`${'#'.repeat(Math.min(level, 6))} ${text}`)
      continue
    }
    body.push(text)
  }
  const bodyText = body.join('\n\n')
  if (yaml) return `---\n${yaml}\n---\n\n${bodyText}\n`
  return `${bodyText}\n`
}

const LANDING_YAML_KEYS = [
  'title',
  'description',
  'section',
  'order',
  'type',
  'audience',
  'owner',
  'sources',
  'lastVerified',
  'related'
]

function looksLikeFlattenedLandingYaml(text) {
  return /^title:\s+\S+.+\bdescription:\s+/s.test(String(text || '').trim())
}

function splitFlattenedYaml(text, keys) {
  const keyRe = new RegExp(`(?:^|\\s)(${keys.join('|')}):`, 'g')
  const hits = []
  let match
  while ((match = keyRe.exec(text)) !== null) {
    const matched = match[0]
    hits.push({
      key: match[1],
      matchStart: match.index + (/^\s/.test(matched) ? 1 : 0),
      valueStart: match.index + matched.length
    })
  }
  const values = {}
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index]
    const end = index + 1 < hits.length ? hits[index + 1].matchStart : text.length
    values[hit.key] = text.slice(hit.valueStart, end).trim()
  }
  return { hits, values }
}

function looksLikeSourcePath(text) {
  return (
    /^(src|tests|landing|resources|docs|scripts)\//.test(text) ||
    /^(package\.json|electron-builder\.yml|pnpm-lock\.yaml)$/.test(text) ||
    /\.(ts|tsx|js|mjs|astro|yml|md)$/.test(text)
  )
}

function looksLikeRelatedId(text) {
  return /^[a-z]+\/[a-z0-9-]+$/.test(text)
}

function wrapLandingInline(text) {
  const providerIds = new Set([
    'openai',
    'anthropic',
    'gemini',
    'ollama',
    'deepseek',
    'groq',
    'openrouter',
    'xai',
    'mistral',
    'custom'
  ])
  let next = text
  next = next.replace(/\b(pnpm pack:(?:win|mac|linux))\b/g, '`$1`')
  next = next.replace(/\bqwen2\.5\b/g, '`qwen2.5`')
  next = next.replace(/\b(OpenAI|OpenRouter|Local)\b/g, '**$1**')
  next = next.replace(/Qwen3-ASR \(local server\)/g, '**Qwen3-ASR (local server)**')
  next = next.replace(/\b(MCPs|Skills|Rules|Packages)\b/g, '**$1**')
  next = next.replace(/\b(Mutating tools|All tools|Not now)\b/g, '**$1**')
  next = next.replace(/\b(Ask for edits and commands|Ask for every tool|Active provider)\b/g, '**$1**')
  if (providerIds.has(next)) return `\`${next}\``
  next = next.replace(
    /(?<!`)\b(openai|anthropic|gemini|ollama|deepseek|groq|openrouter|xai|mistral)\b(?!`)/g,
    '`$1`'
  )
  const emDash = next.match(/^([A-Za-z][A-Za-z0-9_]*)( — [\s\S]+)$/)
  if (emDash && (/^[a-z][a-z0-9_]*$/.test(emDash[1]) || emDash[1] === 'Skill')) {
    return `\`${emDash[1]}\`${emDash[2]}`
  }
  if (
    next === 'Skill' ||
    next.includes('_') ||
    /^(read|edit|search|glob|grep|delete|lsp|terminal|diagnostics)$/.test(next)
  ) {
    return `\`${next}\``
  }
  return next
}

function landingDocxToMarkdown(paragraphs) {
  let index = 0
  while (index < paragraphs.length && !paragraphs[index]?.text) index += 1
  const first = paragraphs[index]?.text?.trim() ?? ''
  if (!looksLikeFlattenedLandingYaml(first)) {
    return skillDocxToMarkdown(paragraphs)
  }

  const { values } = splitFlattenedYaml(first, LANDING_YAML_KEYS)
  index += 1
  const sources = []
  const related = []
  let lastVerified = values.lastVerified || ''

  while (index < paragraphs.length) {
    const paragraph = paragraphs[index]
    const text = paragraph.text?.trim() ?? ''
    if (headingLevel(paragraph.style) > 0) break
    if (!text) {
      index += 1
      continue
    }
    const glued = text.match(/^(.*?)\s+lastVerified:\s+(\S+)\s+related:\s*$/)
    if (glued) {
      if (glued[1]) sources.push(glued[1])
      lastVerified = glued[2]
      index += 1
      continue
    }
    if (looksLikeSourcePath(text)) {
      sources.push(text)
      index += 1
      continue
    }
    if (looksLikeRelatedId(text)) {
      related.push(text)
      index += 1
      continue
    }
    break
  }

  const yaml = [
    `title: ${values.title ?? ''}`.trimEnd(),
    `description: ${values.description ?? ''}`.trimEnd(),
    `section: ${values.section ?? ''}`.trimEnd(),
    `order: ${values.order ?? ''}`.trimEnd(),
    `type: ${values.type ?? ''}`.trimEnd(),
    `audience: ${values.audience ?? ''}`.trimEnd(),
    `owner: ${values.owner ?? ''}`.trimEnd(),
    `lastVerified: ${lastVerified || '1.0.0'}`.trimEnd(),
    'sources:',
    ...sources.map((item) => `  - ${item}`),
    'related:',
    ...related.map((item) => `  - ${item}`)
  ].join('\n')

  const body = []
  for (; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]
    const text = paragraph.text?.trim() ?? ''
    if (!text) continue
    const level = headingLevel(paragraph.style)
    if (level > 0) {
      body.push(`${'#'.repeat(Math.min(level, 6))} ${text}`)
      continue
    }
    body.push(wrapLandingInline(text))
  }

  return `---\n${yaml}\n---\n\n${body.join('\n\n')}\n`
}

function attachmentsMarkdownTable() {
  return [
    '| Kind | Count | Per-item raw size | Processing |',
    '| --- | --- | --- | --- |',
    '| Extracted file | 5 | 8 MB | Main process extracts text; retained text caps at 120,000 characters |',
    '| Image | 4 | 12 MB | Image data URL; requires compatible model input |',
    '| Audio | 2 | 16 MB | Inline audio part; requires compatible provider/model handling |'
  ].join('\n')
}

function docxToText(docxPath) {
  const paragraphs = docxParagraphs(readFileSync(docxPath))
  if (path.basename(docxPath).toLowerCase() === 'skill.md.docx') {
    return skillDocxToMarkdown(paragraphs)
  }
  const rel = path.relative(root, docxPath).replace(/\\/g, '/')
  if (rel.startsWith('landing/src/content/')) {
    let markdown = landingDocxToMarkdown(paragraphs)
    if (rel.endsWith('/attachments.md.docx') && !markdown.includes('| Extracted file |')) {
      markdown = markdown.replace(
        '\n---\n\n',
        `\n---\n\n${attachmentsMarkdownTable()}\n\n`
      )
    }
    return markdown
  }
  return `${paragraphs.map((p) => p.text).filter(Boolean).join('\n\n')}\n`
}

const TARGET_DIRS = [
  path.join(root, 'tests', 'fixtures'),
  path.join(root, 'landing', 'src', 'content'),
  path.join(root, 'resources', 'marketplace')
]

/** Remaining single-file conversion outside TARGET_DIRS. */
const ROOT_FILES = [
  [path.join('landing', 'README.md.docx'), path.join('landing', 'README.md')]
]

function main() {
  let written = 0
  for (const dir of TARGET_DIRS) {
    for (const docxPath of walkDocx(dir)) {
      const outPath = docxPath.replace(/\.md\.docx$/, '.md')
      const text = docxToText(docxPath)
      let existing = null
      try {
        existing = readFileSync(outPath, 'utf8')
      } catch {
        /* first run */
      }
      if (existing === text) continue
      writeFileSync(outPath, text, 'utf8')
      written++
      console.log(`[sync-docx-md] ${path.relative(root, outPath)}`)
    }
  }
  for (const [srcRel, outRel] of ROOT_FILES) {
    const src = path.join(root, srcRel)
    const out = path.join(root, outRel)
    let text
    try {
      text = docxToText(src)
    } catch {
      continue
    }
    if (outRel.replace(/\\/g, '/') === 'landing/README.md' && !text.startsWith('# ')) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? `# ${text}` : `# ${text.slice(0, nl)}${text.slice(nl)}`
    }
    let existing = null
    try {
      existing = readFileSync(out, 'utf8')
    } catch {
      /* first run */
    }
    if (existing !== text) {
      writeFileSync(out, text, 'utf8')
      written++
      console.log(`[sync-docx-md] ${outRel}`)
    }
  }
  console.log(`[sync-docx-md] complete (${written} file(s) updated)`)
}

try {
  main()
} catch (err) {
  console.error('[sync-docx-md] failed:', err)
  process.exit(1)
}
