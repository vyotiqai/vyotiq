import { useEffect, useState } from 'react'
import {
  highlightToLines,
  languageFromPath,
  type CodeToken
} from '@renderer/lib/markdown/markdownHighlight'
import { useDocumentTheme } from '@renderer/lib/ui'
import type { DiffLine } from '../toolUi'

/** Token lists keyed by index in the diff. A missing entry renders as plain text. */
export type DiffTokens = ReadonlyMap<number, CodeToken[]>

const EMPTY: DiffTokens = new Map()
/** Shiki over large docs stalls the UI; later lines stay plain text. */
const HIGHLIGHT_MAX_LINES = 64

/**
 * The line indices making up one side of the change.
 *
 * Each side is highlighted as its own document, because the two interleaved
 * halves of a diff rarely parse as one: a removed line that opens a string and
 * an added line that closes a different one would leave the grammar confused
 * for the rest of the file.
 */
function sideIndices(lines: DiffLine[], removed: boolean): number[] {
  const paired = removed ? 'del' : 'add'
  const out: number[] = []
  lines.forEach((line, index) => {
    if (line.kind === 'context' || line.kind === paired) out.push(index)
  })
  return out
}

async function tokensForSide(
  lines: DiffLine[],
  removed: boolean,
  language: string
): Promise<Array<[number, CodeToken[]]>> {
  const indices = sideIndices(lines, removed)
  if (indices.length === 0) return []

  const source = indices.map((index) => lines[index]!.text).join('\n')
  const highlighted = await highlightToLines(source, language)
  if (!highlighted) return []

  return indices.flatMap((index, position) => {
    const line = highlighted[position]
    return line ? [[index, line] as [number, CodeToken[]]] : []
  })
}

/**
 * Syntax colours for a diff, derived from the file's extension.
 *
 * Returns an empty map while the grammar loads and for files we have no grammar
 * for, so a caller can always render something.
 */
export function useDiffHighlight(lines: DiffLine[], path: string): DiffTokens {
  const [tokens, setTokens] = useState<DiffTokens>(EMPTY)
  const theme = useDocumentTheme()
  const language = languageFromPath(path)

  useEffect(() => {
    if (!language || lines.length === 0) {
      setTokens(EMPTY)
      return undefined
    }

    const source = lines.length > HIGHLIGHT_MAX_LINES ? lines.slice(0, HIGHLIGHT_MAX_LINES) : lines

    let cancelled = false
    void Promise.all([
      tokensForSide(source, false, language),
      tokensForSide(source, true, language)
    ]).then(([added, removed]) => {
      if (cancelled) return
      // Context lines appear on both sides with identical text; either wins.
      setTokens(new Map([...removed, ...added]))
    })

    return () => {
      cancelled = true
    }
  }, [lines, language, theme])

  return tokens
}
