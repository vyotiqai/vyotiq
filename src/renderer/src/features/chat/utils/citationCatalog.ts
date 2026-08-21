import {
  collectCitationCatalog,
  type CitationCatalogEntry,
  type CiteToolEvidence
} from '@shared/utils/inlineCitations'
import type { ToolItem, TranscriptRow } from './transcriptRows'

function evidenceFromToolItem(item: ToolItem): CiteToolEvidence {
  return {
    name: item.tool.name,
    argsPreview: item.tool.argsPreview,
    content: item.tool.content,
    status: item.tool.status
  }
}

/** Catalog of citable file/web sources keyed by transcript turn. */
export function collectTurnCitationCatalogs(
  rows: readonly TranscriptRow[]
): Map<number, CitationCatalogEntry[]> {
  const tools = new Map<number, CiteToolEvidence[]>()
  for (const row of rows) {
    if (row.kind === 'activity') {
      const list = tools.get(row.turnIndex) ?? []
      for (const item of row.tools) list.push(evidenceFromToolItem(item))
      tools.set(row.turnIndex, list)
      continue
    }
    if (row.kind === 'card') {
      const list = tools.get(row.turnIndex) ?? []
      list.push(evidenceFromToolItem(row.item))
      tools.set(row.turnIndex, list)
    }
  }
  const catalogs = new Map<number, CitationCatalogEntry[]>()
  for (const [turn, list] of tools) {
    catalogs.set(turn, collectCitationCatalog(list))
  }
  return catalogs
}
