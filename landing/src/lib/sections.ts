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
