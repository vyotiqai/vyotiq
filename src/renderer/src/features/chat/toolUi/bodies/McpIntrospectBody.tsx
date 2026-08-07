import { useMemo } from 'react'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseMcpIntrospectData } from '../parsers/mcpIntrospect'
import { Chip, TruncatedBanner } from '../primitives'

export function McpIntrospectBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseMcpIntrospectData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {data.filter ? <Chip>{data.filter}</Chip> : null}
        {data.kind === 'tools' && data.tools.length > 0 ? (
          <span className="text-2xs tabular-nums text-tertiary">
            {data.tools.length} {data.tools.length === 1 ? 'tool' : 'tools'}
          </span>
        ) : null}
        {(data.kind === 'resources' || data.kind === 'prompts') && data.entries.length > 0 ? (
          <span className="text-2xs tabular-nums text-tertiary">
            {data.entries.length} {data.entries.length === 1 ? 'entry' : 'entries'}
          </span>
        ) : null}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}

      {data.message ? (
        <p className={`${TOOL_BODY_PAD} m-0 text-caption text-tertiary`}>{data.message}</p>
      ) : null}

      {data.kind === 'tools' && data.tools.length > 0 ? (
        <ul className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} m-0 list-none space-y-1.5 p-0`}>
          {data.tools.map((row) => (
            <li key={row.name} className="min-w-0 text-caption">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate font-mono text-fg/90" title={row.name}>
                  {row.name}
                </span>
                {row.readOnly === true ? (
                  <span className="text-2xs text-tertiary">read-only</span>
                ) : row.readOnly === false ? (
                  <span className="text-2xs text-tertiary">write</span>
                ) : null}
              </div>
              {row.description ? (
                <div className="mt-0.5 text-fg/70 [overflow-wrap:anywhere]">{row.description}</div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {(data.kind === 'resources' || data.kind === 'prompts') && data.entries.length > 0 ? (
        <ul className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} m-0 list-none space-y-1.5 p-0`}>
          {data.entries.map((row) => (
            <li key={`${row.serverId}:${row.label}`} className="min-w-0 text-caption">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-2xs text-tertiary">{row.serverId}</span>
                <span className="min-w-0 truncate font-mono text-fg/90" title={row.label}>
                  {row.label}
                </span>
              </div>
              {row.meta ? (
                <div className="mt-0.5 text-fg/70 [overflow-wrap:anywhere]">{row.meta}</div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {data.kind === 'resource' && data.text ? (
        <pre
          className={`${TOOL_BODY_INNER} m-0 ${TOOL_BODY_FLOW} font-mono text-caption leading-relaxed whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]`}
          aria-busy={loading || undefined}
        >
          {data.text}
        </pre>
      ) : null}

      {data.kind === 'prompt' ? (
        <div className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} space-y-2`}>
          {data.text ? <p className="m-0 text-caption text-fg/80">{data.text}</p> : null}
          {data.blocks.map((block, i) => (
            <div key={`${block.role}:${i}`} className="min-w-0">
              {block.role ? (
                <div className="mb-0.5 text-2xs font-medium uppercase tracking-wide text-tertiary">
                  {block.role}
                </div>
              ) : null}
              <pre className="m-0 font-mono text-caption leading-relaxed whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]">
                {block.text}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
