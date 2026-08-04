import { useEffect, useMemo, useState } from 'react'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { useRunSession } from '../../RunSessionContext'
import type { ToolBodyProps } from '../types'
import {
  parseBrowserActionData,
  parseBrowserSnapshotData,
  parseBrowserTabsData
} from '../parsers/browser'
import { Chip, TruncatedBanner } from '../primitives'

export function BrowserSnapshotBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseBrowserSnapshotData(tool), [tool])
  const { workspacePath, runId } = useRunSession()
  const [screenshotSrc, setScreenshotSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!data.screenshotNote || !workspacePath || !runId) {
      setScreenshotSrc(null)
      return
    }
    let cancelled = false
    void window.vyotiq
      .readRunArtifact({ workspacePath, runId, name: 'browser/snapshot.jpg' })
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.data.exists && res.data.content) {
          setScreenshotSrc(res.data.content)
        } else {
          setScreenshotSrc(null)
        }
      })
      .catch(() => {
        if (!cancelled) setScreenshotSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [data.screenshotNote, workspacePath, runId, tool.id])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {data.url ? <Chip>{data.url}</Chip> : null}
        {data.title ? (
          <span className="truncate text-[11px] text-fg/80" title={data.title}>
            {data.title}
          </span>
        ) : null}
        {data.tabId ? (
          <span className="text-[10px] tabular-nums text-tertiary">{data.tabId}</span>
        ) : null}
        {data.viewport ? (
          <span className="text-[10px] tabular-nums text-tertiary">{data.viewport}</span>
        ) : null}
        {data.refs.length > 0 ? (
          <span className="text-[10px] tabular-nums text-tertiary">
            {data.refs.length} {data.refs.length === 1 ? 'ref' : 'refs'}
          </span>
        ) : null}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      {data.message ? (
        <p className={`${TOOL_BODY_PAD} m-0 text-[11px] text-tertiary`}>{data.message}</p>
      ) : null}
      {data.refs.length > 0 ? (
        <ul className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} m-0 list-none space-y-0.5 p-0`}>
          {data.refs.map((ref) => (
            <li
              key={ref.id}
              className="flex min-w-0 items-baseline gap-2 font-mono text-[11px] text-fg/80"
            >
              <span className="shrink-0 text-accent">@{ref.id}</span>
              <span className="shrink-0 text-tertiary">{ref.role}</span>
              <span className="min-w-0 truncate" title={ref.name || ref.css}>
                {ref.name || ref.css}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.body ? (
        <pre
          className={`${TOOL_BODY_INNER} m-0 ${TOOL_BODY_FLOW} font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/75 [overflow-wrap:anywhere]`}
        >
          {data.body}
        </pre>
      ) : null}
      {screenshotSrc ? (
        <div className={`${TOOL_BODY_PAD} pt-1`}>
          <img
            src={screenshotSrc}
            alt="Browser snapshot"
            className="max-h-48 w-full rounded border border-border/60 object-contain object-top"
          />
        </div>
      ) : data.screenshotNote ? (
        <p className={`${TOOL_BODY_PAD} m-0 pt-1 text-[10px] text-tertiary`}>{data.screenshotNote}</p>
      ) : null}
    </div>
  )
}

export function BrowserTabsBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseBrowserTabsData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        <Chip>{data.action}</Chip>
        {data.tabs.length > 0 ? (
          <span className="text-[10px] tabular-nums text-tertiary">
            {data.tabs.length} {data.tabs.length === 1 ? 'tab' : 'tabs'}
          </span>
        ) : null}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      {data.tabs.length > 0 ? (
        <ul className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} m-0 list-none space-y-1 p-0`}>
          {data.tabs.map((tab) => (
            <li key={tab.id} className="min-w-0 font-mono text-[11px] text-fg/80">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-tertiary">{tab.id}</span>
                <span className="min-w-0 truncate" title={tab.title}>
                  {tab.title}
                </span>
              </div>
              <div className="truncate text-[10px] text-accent" title={tab.url}>
                {tab.url}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`${TOOL_BODY_PAD} m-0 text-[11px] text-fg/80`}>{data.message || 'No tabs'}</p>
      )}
    </div>
  )
}

export function BrowserActionBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseBrowserActionData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {data.target ? <Chip>{data.target}</Chip> : null}
        {data.tabId ? (
          <span className="text-[10px] tabular-nums text-tertiary">{data.tabId}</span>
        ) : null}
        {data.failed && !loading ? (
          <span className="text-[10px] font-medium text-danger">Failed</span>
        ) : null}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <p
        className={`${TOOL_BODY_PAD} m-0 text-[11px] [overflow-wrap:anywhere] ${
          data.failed && !loading ? 'text-danger' : 'text-fg/80'
        }`}
        aria-busy={loading || undefined}
      >
        {data.message || (loading ? 'Working…' : '')}
      </p>
    </div>
  )
}
