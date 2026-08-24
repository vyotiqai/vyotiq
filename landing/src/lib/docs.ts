import { getCollection, type CollectionEntry } from 'astro:content'

export const DOC_SECTIONS = [
  'start',
  'agent',
  'customize',
  'tools',
  'concepts',
  'reference',
  'troubleshooting'
] as const

export type DocSection = (typeof DOC_SECTIONS)[number]

export const DOC_SECTION_LABEL: Record<DocSection, string> = {
  start: 'Start here',
  agent: 'Work with Agent',
  customize: 'Customize',
  tools: 'Tools and panels',
  concepts: 'Concepts and security',
  reference: 'Reference',
  troubleshooting: 'Troubleshooting'
}

export function docsHref(id: string): string {
  return `/docs/${id}`
}

export type DocsNavGroup = {
  section: DocSection
  label: string
  entries: CollectionEntry<'docs'>[]
}

export async function orderedDocs(): Promise<CollectionEntry<'docs'>[]> {
  const entries = await getCollection('docs')
  return [...entries].sort((a, b) => {
    if (a.data.section !== b.data.section) {
      return DOC_SECTIONS.indexOf(a.data.section) - DOC_SECTIONS.indexOf(b.data.section)
    }
    if (a.data.order !== b.data.order) return a.data.order - b.data.order
    return a.data.title.localeCompare(b.data.title)
  })
}

export async function groupedDocs(): Promise<DocsNavGroup[]> {
  const sorted = await orderedDocs()
  return DOC_SECTIONS.map((section) => ({
    section,
    label: DOC_SECTION_LABEL[section],
    entries: sorted.filter((entry) => entry.data.section === section)
  })).filter((group) => group.entries.length > 0)
}

function searchableMarkdown(body: string): string {
  return body
    .replace(/^---[\s\S]*?---/, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#|~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type DocsSearchEntry = {
  id: string
  title: string
  description: string
  section: string
  href: string
  text: string
}

export async function docsSearchEntries(): Promise<DocsSearchEntry[]> {
  const entries = await orderedDocs()
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.data.title,
    description: entry.data.description,
    section: DOC_SECTION_LABEL[entry.data.section],
    href: docsHref(entry.id),
    text: searchableMarkdown(entry.body)
  }))
}

export async function docsPageContext(currentId: string): Promise<{
  sectionLabel: string
  previous: CollectionEntry<'docs'> | null
  next: CollectionEntry<'docs'> | null
  related: CollectionEntry<'docs'>[]
}> {
  const entries = await orderedDocs()
  const currentIndex = entries.findIndex((entry) => entry.id === currentId)
  const current = currentIndex >= 0 ? entries[currentIndex] : null
  if (!current) {
    return { sectionLabel: 'Docs', previous: null, next: null, related: [] }
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  return {
    sectionLabel: DOC_SECTION_LABEL[current.data.section],
    previous: currentIndex > 0 ? entries[currentIndex - 1]! : null,
    next: currentIndex < entries.length - 1 ? entries[currentIndex + 1]! : null,
    related: current.data.related.flatMap((id) => {
      const entry = byId.get(id)
      return entry ? [entry] : []
    })
  }
}
