import { memo } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import {
  DISCLOSURE_ROW,
  TOOL_BODY_CLAMP_PX,
  TOOL_CARD_BODY,
  TOOL_CARD_HEADER,
  TOOL_CARD_SURFACE
} from '@renderer/lib/utils/layout'
import { TextShimmer } from '../components/TextShimmer'

export function ProminentChrome({
  header,
  body,
  expanded,
  hasBody,
  running,
  clampWhenCollapsed = true,
  ariaLabel,
  onToggle
}: {
  header: React.ReactNode
  body: React.ReactNode
  expanded: boolean
  hasBody: boolean
  running: boolean
  /** When false, the collapsed preview is not height-clamped (e.g. task checklists). */
  clampWhenCollapsed?: boolean
  ariaLabel?: string
  onToggle: () => void
}) {
  return (
    <div className={cn(TOOL_CARD_SURFACE, 'w-full')} aria-busy={running || undefined}>
      <button
        type="button"
        className={cn(
          TOOL_CARD_HEADER,
          'flex w-full items-center gap-2 text-left vy-transition',
          hasBody && 'hover:bg-surface/60'
        )}
        onClick={onToggle}
        aria-label={ariaLabel}
        aria-expanded={hasBody ? expanded : undefined}
        disabled={!hasBody}
      >
        {header}
        {hasBody ? (
          <Icon
            name="chevronRight"
            size={14}
            className={cn('shrink-0 text-tertiary vy-transition', expanded && 'rotate-90')}
          />
        ) : null}
      </button>
      {hasBody && body ? (
        <div
          className={cn(TOOL_CARD_BODY, !expanded && clampWhenCollapsed && 'mask-fade-bottom')}
          style={
            !expanded && clampWhenCollapsed ? { maxHeight: TOOL_BODY_CLAMP_PX } : undefined
          }
          // Body owns scrolling (e.g. terminal viewport); avoid a second scrollport.
          data-tool-card-body=""
        >
          {body}
        </div>
      ) : null}
    </div>
  )
}

export const CompactRow = memo(function CompactRow({
  title,
  subtitle,
  status,
  expanded,
  hasBody = true,
  interrupted = false,
  icon,
  statusDot,
  onToggle
}: {
  title: string
  subtitle: string
  status: 'running' | 'done' | 'fail'
  expanded: boolean
  hasBody?: boolean
  interrupted?: boolean
  icon?: IconName
  statusDot?: 'running' | 'done' | 'fail'
  onToggle: () => void
}) {
  const disclosureLabel = hasBody
    ? `${expanded ? 'Collapse' : 'Expand'} ${title}${subtitle ? `: ${subtitle}` : ''}`
    : title
  return (
    <button
      type="button"
      className={cn(DISCLOSURE_ROW, 'w-full text-left', !hasBody && 'cursor-default')}
      aria-label={disclosureLabel}
      aria-expanded={hasBody ? expanded : undefined}
      disabled={!hasBody}
      onClick={onToggle}
    >
      <span
        className={cn(
          'flex shrink-0 items-center gap-1.5 font-medium tool-status-morph',
          interrupted || status === 'fail' ? 'text-danger' : 'text-fg'
        )}
      >
        {icon ? <Icon name={icon} size={14} className="shrink-0 text-tertiary" /> : null}
        {statusDot ? (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              statusDot === 'running' && 'bg-tertiary',
              statusDot === 'done' && 'bg-success',
              statusDot === 'fail' && 'bg-danger'
            )}
          />
        ) : null}
        {status === 'running' ? <TextShimmer>{title}</TextShimmer> : title}
      </span>
      {subtitle ? (
        <span className="min-w-0 truncate text-tertiary" title={subtitle}>
          {subtitle}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {interrupted ? <span className="text-danger">interrupted</span> : null}
        {!interrupted && status === 'fail' ? (
          <Icon
            name="warning"
            size={14}
            className="shrink-0 text-danger tool-status-morph"
          />
        ) : null}
        {hasBody ? (
          <Icon
            name="chevronRight"
            size={14}
            className={cn('shrink-0 text-tertiary vy-transition', expanded && 'rotate-90')}
          />
        ) : null}
      </span>
    </button>
  )
})
