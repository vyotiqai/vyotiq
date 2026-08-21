import {
  SkillFrontmatterSchema,
  type SkillFrontmatter,
  skillPackageVersion
} from '../../../shared/ipc'

export { skillPackageVersion }

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim()
}

/**
 * Parse simple YAML frontmatter including optional nested `metadata:` maps.
 * Not a full YAML parser — sufficient for Agent Skills frontmatter.
 */
function parseBlockScalar(
  lines: string[],
  start: number,
  marker: string
): { value: string; nextIndex: number } {
  const block: string[] = []
  let indent: number | undefined
  let index = start

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      block.push('')
      index += 1
      continue
    }
    const leading = /^\s*/.exec(line)?.[0].length ?? 0
    if (leading === 0) break
    indent ??= leading
    block.push(line.slice(indent).trimEnd())
    index += 1
  }

  const value = marker.startsWith('|')
    ? block.join('\n')
    : block.join(' ').replace(/[ \t]+/g, ' ')
  return { value: value.trim(), nextIndex: index - 1 }
}

function parseFrontmatterFields(yaml: string): Record<string, string | Record<string, string>> {
  const fields: Record<string, string | Record<string, string>> = {}
  let inMetadata = false
  const metadata: Record<string, string> = {}
  const lines = yaml.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue

    const metaLine = /^(?: {2}|\t)([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine)
    if (inMetadata && metaLine) {
      metadata[metaLine[1]] = stripQuotes(metaLine[2])
      continue
    }

    // Leaving an indented block
    if (inMetadata && !/^\s/.test(rawLine)) {
      inMetadata = false
      if (Object.keys(metadata).length > 0) fields.metadata = { ...metadata }
    }

    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine.trim())
    if (!top) continue
    const key = top[1]
    const value = top[2].trim()

    if (key === 'metadata' && value === '') {
      inMetadata = true
      continue
    }
    if (key === 'metadata' && value.startsWith('{')) {
      // Inline JSON-ish maps are not supported; ignore
      continue
    }
    inMetadata = false
    if (value === '>' || value === '>-' || value === '|' || value === '|-') {
      const block = parseBlockScalar(lines, index + 1, value)
      fields[key] = block.value
      index = block.nextIndex
      continue
    }
    fields[key] = stripQuotes(value)
  }

  if (inMetadata && Object.keys(metadata).length > 0) {
    fields.metadata = { ...metadata }
  }

  return fields
}

export function parseSkillFrontmatter(raw: string): SkillFrontmatter & { body: string } {
  const trimmed = raw.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---')) {
    throw new Error('SKILL.md must start with YAML frontmatter (---)')
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed')
  const yaml = trimmed.slice(3, end).trim()
  const body = trimmed.slice(end + 4).replace(/^\r?\n/, '')
  const fields = parseFrontmatterFields(yaml)

  const metadata: Record<string, string> = {}
  const rawMeta = fields.metadata
  if (rawMeta && typeof rawMeta === 'object') {
    Object.assign(metadata, rawMeta)
  }
  // Legacy top-level `version:` → metadata.version
  const legacyVersion = fields.version
  if (typeof legacyVersion === 'string' && legacyVersion && !metadata.version) {
    metadata.version = legacyVersion
  }

  const parsed = SkillFrontmatterSchema.parse({
    name: fields.name,
    description: fields.description,
    license: typeof fields.license === 'string' ? fields.license : undefined,
    compatibility: typeof fields.compatibility === 'string' ? fields.compatibility : undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    'allowed-tools':
      typeof fields['allowed-tools'] === 'string' ? fields['allowed-tools'] : undefined
  })
  return { ...parsed, body }
}
