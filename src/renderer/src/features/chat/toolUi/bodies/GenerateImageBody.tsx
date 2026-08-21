import { useEffect, useMemo, useState } from 'react'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { useRunSession } from '../../RunSessionContext'
import type { ToolBodyProps } from '../types'
import { parseGenerateImageData } from '../parsers/generateImage'
import { TruncatedBanner } from '../primitives'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function GenerateImageBody({
  tool,
  loading,
  loadFailed,
  inGroup,
  toolProgress
}: ToolBodyProps) {
  const data = useMemo(() => parseGenerateImageData(tool), [tool])
  const { workspacePath } = useRunSession()
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const running = tool.status === 'running'
  const progressText =
    running && toolProgress && toolProgress.length > 0
      ? (toolProgress[toolProgress.length - 1]?.text ?? null)
      : null

  const showPreview =
    !data.dryRun &&
    tool.status === 'done' &&
    Boolean(data.path) &&
    Boolean(workspacePath) &&
    /^ok:\s*true\b/im.test(data.body)

  useEffect(() => {
    if (!showPreview || !workspacePath || !data.path) {
      setPreviewSrc(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    setPreviewSrc(null)
    setPreviewError(null)
    void window.vyotiq
      .workspaceReadImage({ workspacePath, path: data.path })
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          setPreviewSrc(res.data.dataUrl)
          setPreviewError(null)
        } else {
          setPreviewSrc(null)
          setPreviewError(res.error)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewSrc(null)
          setPreviewError('Could not load preview')
        }
      })
    return () => {
      cancelled = true
    }
  }, [showPreview, workspacePath, data.path, tool.id])

  const metaBits = [
    data.action === 'edit' ? 'edit' : null,
    data.dryRun ? 'dry-run' : null,
    data.provider,
    data.model,
    data.mimeType,
    data.byteLength != null ? formatBytes(data.byteLength) : null
  ].filter(Boolean)

  return (
    <div>
      {!inGroup ? (
        <div className={`${TOOL_BODY_PAD} border-b border-border pb-2`}>
          <span className="truncate font-mono text-2xs text-tertiary" title={data.path}>
            {data.path || '(no path)'}
          </span>
          {data.references ? (
            <div className="mt-1 truncate text-2xs text-tertiary" title={data.references}>
              refs: {data.references}
            </div>
          ) : null}
          {metaBits.length > 0 ? (
            <div className="mt-1 truncate text-2xs text-secondary">{metaBits.join(' · ')}</div>
          ) : null}
        </div>
      ) : null}
      {progressText ? (
        <p className={`${TOOL_BODY_PAD} m-0 py-1.5 text-caption text-secondary`}>{progressText}</p>
      ) : null}
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      {data.prompt ? (
        <div className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} text-caption text-fg/80`}>
          {data.prompt}
        </div>
      ) : data.body && !previewSrc ? (
        <pre
          className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} whitespace-pre-wrap font-mono text-2xs text-fg/70`}
        >
          {data.body}
        </pre>
      ) : null}
      {data.revisedPrompt ? (
        <div className={`${TOOL_BODY_PAD} pt-1 text-2xs text-tertiary`}>
          revised: {data.revisedPrompt}
        </div>
      ) : null}
      {data.maskPath ? (
        <div className={`${TOOL_BODY_PAD} pt-0.5 text-2xs text-tertiary`} title={data.maskPath}>
          mask: {data.maskPath}
        </div>
      ) : null}
      {previewSrc ? (
        <div className={`${TOOL_BODY_PAD} pt-1`}>
          <img
            src={previewSrc}
            alt={data.path || 'Generated image'}
            className="max-h-56 w-full rounded border border-border/60 object-contain"
          />
        </div>
      ) : previewError && showPreview ? (
        <p className={`${TOOL_BODY_PAD} m-0 pt-1 text-2xs text-tertiary`}>{previewError}</p>
      ) : null}
    </div>
  )
}
