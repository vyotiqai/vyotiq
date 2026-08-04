import { memo, useMemo } from 'react'
import { cn } from '@renderer/lib/ui'
import type { DiffLine } from '../toolUi'
import { useDiffHighlight, type DiffTokens } from './useDiffHighlight'

/** Enough of the change to recognise it without turning the transcript into a file. */
const COLLAPSED_LINES = 14
/**
 * Hard cap even when expanded. Full diffs (up to ~100k chars from git) as DOM +
 * syntax highlight freeze the renderer — especially Expand All.
 */
const MAX_EXPANDED_LINES = 200

export type DiffLayout = 'unified' | 'split'

function LineText({
  line,
  tokens
}: {
  line: DiffLine
  tokens?: readonly { text: string; color?: string }[]
}) {
  if (!tokens?.length) return <>{line.text || '\u00a0'}</>

  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} style={token.color ? { color: token.color } : undefined}>
          {token.text}
        </span>
      ))}
    </>
  )
}

/**
 * Row cues: background tint marks add/del; compact line # for location.
 * Sign column (+/−) dropped — redundant with tint and stole dock width (D2/D7).
 */
function DiffLines({
  lines,
  path,
  expanded,
  findQuery,
  wordWrap
}: {
  lines: DiffLine[]
  path: string
  expanded?: boolean
  findQuery?: string
  wordWrap?: boolean
}) {
  const q = findQuery?.trim().toLowerCase() ?? ''
  const filtered = useMemo(() => {
    if (!q) return lines
    return lines.filter(
      (line) => line.kind === 'gap' || line.text.toLowerCase().includes(q)
    )
  }, [lines, q])

  const visible = useMemo(() => {
    const limit = expanded ? MAX_EXPANDED_LINES : COLLAPSED_LINES
    return filtered.length > limit ? filtered.slice(0, limit) : filtered
  }, [filtered, expanded])
  const tokens: DiffTokens = useDiffHighlight(visible, path)

  if (!filtered.length) return null
  const hidden = filtered.length - visible.length

  return (
    <div
      className={cn(
        'overflow-hidden font-mono text-[11px] leading-[1.6]',
        wordWrap && '[&_pre]:whitespace-pre-wrap'
      )}
    >
      {visible.map((line, index) => {
        if (line.kind === 'gap') {
          return (
            <div
              key={`gap-${index}`}
              className="h-3 border-y border-border/60 bg-surface-2/40"
              aria-hidden
            />
          )
        }

        const match = q.length > 0 && line.text.toLowerCase().includes(q)

        return (
          <div
            key={`${line.kind}-${index}`}
            className={cn(
              'flex min-w-0',
              line.kind === 'add' && 'diff-row-add',
              line.kind === 'del' && 'diff-row-del',
              match && 'ring-1 ring-inset ring-accent/40'
            )}
          >
            <span
              className="w-5 shrink-0 select-none pr-1 text-right tabular-nums text-[10px] text-tertiary/55"
              aria-hidden={line.lineNumber == null}
            >
              {line.lineNumber ?? ''}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap pr-2 text-fg/85 [overflow-wrap:anywhere]">
              <LineText line={line} tokens={tokens.get(index)} />
            </span>
          </div>
        )
      })}
      {hidden > 0 ? (
        <p className="m-0 px-2 py-1 text-[10px] text-tertiary">
          {hidden} more {hidden === 1 ? 'line' : 'lines'}
        </p>
      ) : null}
    </div>
  )
}

export const DiffPreview = memo(function DiffPreview({
  lines,
  path,
  expanded,
  layout = 'unified',
  findQuery,
  wordWrap
}: {
  lines: DiffLine[]
  /** Used to pick a grammar for syntax colours. */
  path: string
  expanded?: boolean
  layout?: DiffLayout
  findQuery?: string
  wordWrap?: boolean
}) {
  const splitSides = useMemo(() => {
    if (layout !== 'split') return null
    return {
      left: lines.filter((l) => l.kind === 'del' || l.kind === 'context' || l.kind === 'gap'),
      right: lines.filter((l) => l.kind === 'add' || l.kind === 'context' || l.kind === 'gap')
    }
  }, [lines, layout])

  if (!lines.length) return null

  if (splitSides) {
    return (
      <div className="grid min-w-0 grid-cols-2 gap-px overflow-hidden bg-border/40">
        <div className="min-h-0 min-w-0 overflow-auto bg-bg">
          <DiffLines
            lines={splitSides.left}
            path={path}
            expanded={expanded}
            findQuery={findQuery}
            wordWrap={wordWrap}
          />
        </div>
        <div className="min-h-0 min-w-0 overflow-auto bg-bg">
          <DiffLines
            lines={splitSides.right}
            path={path}
            expanded={expanded}
            findQuery={findQuery}
            wordWrap={wordWrap}
          />
        </div>
      </div>
    )
  }

  return (
    <DiffLines
      lines={lines}
      path={path}
      expanded={expanded}
      findQuery={findQuery}
      wordWrap={wordWrap}
    />
  )
})
