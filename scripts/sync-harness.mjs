/**
 * Validate the canonical plain-text runtime harness.
 *
 * resources/harness/default.md is source of truth. This script intentionally
 * never reads a Word copy and never rewrites harness policy.
 *
 * docxParagraphs remains exported for scripts/sync-docx-md.mjs, which converts
 * unrelated documentation and fixture assets.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..')

/** Minimal ZIP reader used by the separate documentation conversion script. */
export function readZipEntry(buf, wantedName) {
  let eocd = -1
  const minEocd = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no EOCD)')

  const entryCount = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('bad central directory')
    const method = buf.readUInt16LE(ptr + 10)
    const compressedSize = buf.readUInt32LE(ptr + 20)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOffset = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    if (name === wantedName) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header')
      const localNameLen = buf.readUInt16LE(localOffset + 26)
      const localExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      const raw = buf.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return Buffer.from(raw)
      if (method === 8) return inflateRawSync(raw)
      throw new Error(`unsupported zip compression method: ${method}`)
    }
    ptr += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`zip entry not found: ${wantedName}`)
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
}

function decodeRuns(paragraphXml) {
  const withoutBreaks = paragraphXml.replace(/<w:br\s*\/>/g, '\n').replace(/<w:tab\s*\/>/g, ' ')
  const runs = []
  const runRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
  let match
  while ((match = runRe.exec(withoutBreaks)) !== null) runs.push(match[1])
  return unescapeXml(runs.join(''))
}

function headingStyle(paragraphXml) {
  return paragraphXml.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? ''
}

/** Paragraph blocks consumed only by scripts/sync-docx-md.mjs. */
export function docxParagraphs(docxBuf) {
  const xml = readZipEntry(docxBuf, 'word/document.xml').toString('utf8')
  const paragraphs = []
  for (const chunk of xml.split('</w:p>')) {
    const openIndex = chunk.search(/<w:p(?:\s[^>]*)?>/)
    if (openIndex < 0) continue
    const paragraphXml = chunk.slice(openIndex)
    const text = decodeRuns(paragraphXml).trim()
    const border = /<w:pBdr[\s>]/.test(paragraphXml)
    if (text || border) {
      paragraphs.push({ style: headingStyle(paragraphXml), text, border })
    }
  }
  return paragraphs
}

export const REQUIRED_HARNESS_SECTION_TAGS = [
  'role',
  'capabilities',
  'tool_policy',
  'constraints',
  'work_style',
  'memory',
  'output_format'
]

export function validateHarnessMarkdown(text) {
  const errors = []
  if (!text.startsWith('# Agent V\n')) errors.push('must start with "# Agent V"')
  if (/^##\s+/m.test(text)) errors.push('must use section tags, not level-two headings')
  if (text.includes('<workspace_harness>') || text.includes('</workspace_harness>')) {
    errors.push('must not wrap the canonical spine as a workspace appendix')
  }
  for (const tag of REQUIRED_HARNESS_SECTION_TAGS) {
    const opens = text.match(new RegExp(`<${tag}>`, 'g'))?.length ?? 0
    const closes = text.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0
    if (opens !== 1 || closes !== 1) errors.push(`<${tag}> must appear exactly once as a pair`)
  }
  return errors
}

function main() {
  const harnessPath = path.join(ROOT, 'resources', 'harness', 'default.md')
  const errors = validateHarnessMarkdown(readFileSync(harnessPath, 'utf8'))
  if (errors.length > 0) {
    throw new Error(`invalid canonical harness:\n- ${errors.join('\n- ')}`)
  }
  console.log('[sync-harness] canonical resources/harness/default.md is valid')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error('[sync-harness] failed:', err)
    process.exit(1)
  }
}
